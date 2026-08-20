/**
 * follow on/off — claim 注册（含竞态防护）、心跳、pending 轮询的启停
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import type { FeishuConfig } from "./types";
import { removeClaim, touchHeartbeat, getChatClaims, addClaim } from "./claim";
import { registerClaim } from "./claim-register";
import { consumePending, clearPending } from "./pending";
import { dispatchPending } from "./pending-dispatch";
import { drainAcked } from "./outbox";

import { type HandlerState } from "./handlers";

export type CommandCtx = {
	ui: { notify: (msg: string, type?: "info" | "error" | "warning") => void };
};

export const HEARTBEAT_INTERVAL_MS = 30_000;
export const POLL_INTERVAL_MS = 2_000;

export interface FollowController {
	followed: () => boolean;
	sessionName: () => string;
	/** follow on：claim + 心跳 + 轮询 */
	on: (ctx: CommandCtx) => Promise<void>;
	/** follow off：释放 + 停定时器 */
	off: (ctx: CommandCtx) => Promise<void>;
	/** 改名（保留原 claimedAt；占用时拒绝） */
	rename: (ctx: CommandCtx, name: string) => void;
	/** session_shutdown 清理（静默） */
	shutdown: () => void;
}

export function createFollowController(
	pi: ExtensionAPI,
	deps: {
		config: FeishuConfig;
		log: (msg: string) => void;
		state: HandlerState;
		setOutboundActive: (v: boolean) => void;
		getSelfSessionId: () => string;
	},
): FollowController {
	const { config } = deps;
	let followed = false;
	let sessionName = "";
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;

	function stopTimers(): void {
		if (heartbeatTimer) {
			clearInterval(heartbeatTimer);
			heartbeatTimer = null;
		}
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
	}

	async function on(ctx: CommandCtx): Promise<void> {
		if (!config.chatId) {
			ctx.ui.notify(
				"⚠️ pi-feishu 未激活：请在 settings.json 的 feishu.chatId 配置目标群 chat_id",
				"warning",
			);
			return;
		}
		if (followed) {
			ctx.ui.notify(`已 follow（会话名: ${sessionName}）`, "info");
			return;
		}

		const selfSessionId = deps.getSelfSessionId();
		const desired = config.sessionName ?? (path.basename(process.cwd()) || "session");
		// 写入后回读校验：几乎同时 follow 的同名竞态让位追加后缀（claim-register.ts）
		sessionName = registerClaim(config.chatId, selfSessionId, desired);

		// 出站全走 outbox（网关发送），会话侧无需 REST client / 凭据
		deps.setOutboundActive(true);

		// 清理上次会话遗留 pending（不注入过期指令）
		clearPending(selfSessionId);

		// 心跳：30s 更新 claim.heartbeat（事件循环层独立于 AI 回合）
		heartbeatTimer = setInterval(() => {
			try {
				touchHeartbeat(config.chatId, selfSessionId);
			} catch {
				// claim 文件瞬时竞态可容忍，下一拍重试
			}
		}, HEARTBEAT_INTERVAL_MS);

		// pending 轮询：~2s 读自己的指令文件 → 删 → 分发（dispatchPending）
		pollTimer = setInterval(() => {
			try {
				const pending = consumePending(selfSessionId);
				if (pending) dispatchPending(pi, deps.state, pending, deps.log);
				// 同一 tick 取走 outbox 回执（expectAck 条目的网关回写）
				const acked = drainAcked(selfSessionId);
				if (acked.length > 0) deps.log(`[pi-feishu] outbox 回执 ${acked.length} 条`);
			} catch {
				// 轮询异常不致命
			}
		}, POLL_INTERVAL_MS);

		followed = true;
		ctx.ui.notify(
			`✅ 飞书已 follow（会话名: ${sessionName}），等待网关分发`,
			"info",
		);
	}

	async function off(ctx: CommandCtx): Promise<void> {
		if (!followed) {
			ctx.ui.notify("当前未 follow", "info");
			return;
		}
		removeClaim(config.chatId, deps.getSelfSessionId());
		clearPending(deps.getSelfSessionId());
		stopTimers();
		followed = false;
		deps.setOutboundActive(false);
		ctx.ui.notify(`已停止 follow（会话名: ${sessionName}）`, "info");
	}

	function rename(ctx: CommandCtx, name: string): void {
		if (!name) {
			ctx.ui.notify(`当前会话名: ${sessionName || "（未命名）"}`, "info");
			return;
		}
		const selfSessionId = deps.getSelfSessionId();
		const conflict = getChatClaims(config.chatId).some(
			(e) => e.sessionName === name && e.sessionId !== selfSessionId,
		);
		if (conflict) {
			ctx.ui.notify(`会话名 "${name}" 已被占用`, "warning");
			return;
		}
		if (followed) {
			const existing = getChatClaims(config.chatId).find(
				(e) => e.sessionId === selfSessionId,
			);
			// 改名保留原 claimedAt 与心跳
			addClaim(config.chatId, {
				sessionId: selfSessionId,
				sessionName: name,
				claimedAt: existing?.claimedAt ?? Date.now(),
				heartbeat: Date.now(),
			});
		}
		sessionName = name;
		ctx.ui.notify(`会话名已改为: ${name}`, "info");
	}

	function shutdown(): void {
		if (!followed) return;
		try {
			removeClaim(config.chatId, deps.getSelfSessionId());
			clearPending(deps.getSelfSessionId());
		} catch {
			// ignore
		}
		stopTimers();
		followed = false;
	}

	return {
		followed: () => followed,
		sessionName: () => sessionName,
		on,
		off,
		rename,
		shutdown,
	};
}
