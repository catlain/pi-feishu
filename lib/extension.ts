/**
 * 扩展主体 — 状态管理 + 命令/事件注册
 * 会话侧为薄客户端：claim + 心跳 + pending 轮询 + 出站播报。
 * 入站 WS / 路由全部在网关进程（lib/gateway/main.ts）。
 */

import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getFeishuConfig } from "./config";
import { getCredentials } from "./credentials";
import { FeishuBridgeClient } from "./client";
import {
	addClaim,
	getChatClaims,
	removeClaim,
	touchHeartbeat,
	isAlive,
} from "./claim";
import { consumePending, clearPending } from "./pending";
import { generateSessionName } from "./naming";
import { gatewayOn, gatewayOff, gatewayStatus } from "./gateway/commands";
import {
	handleAgentEnd,
	handleAskUserPrompt,
	injectFeishuCommand,
	type HandlerState,
} from "./handlers";

/** 命令 ctx 的最小结构（notify 类型对齐 SDK：第二参数为字面量联合） */
export type CommandCtx = {
	ui: { notify: (msg: string, type?: "info" | "error" | "warning") => void };
};

const HEARTBEAT_INTERVAL_MS = 30_000;
const POLL_INTERVAL_MS = 2_000;

export const createFeishuExtension: ExtensionFactory = (pi) => {
	const config = getFeishuConfig(process.cwd());
	const credentials = getCredentials(config);

	let bridge: FeishuBridgeClient | null = null;
	let followed = false;
	let sessionName = "";
	let selfSessionId = "";
	let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	let pollTimer: ReturnType<typeof setInterval> | null = null;
	/** 最近一次事件 ctx（isIdle 判断需要） */
	let liveCtx: ExtensionContext | null = null;

	const log = (msg: string) => {
		try {
			pi.events.emit("pi-feishu:log", { msg });
		} catch {
			// ignore
		}
	};

	const state: HandlerState = {
		get selfSessionId() {
			return selfSessionId;
		},
		sessionName: () => sessionName,
		config,
		botOpenId: () => null,
		liveCtx: () => liveCtx,
		sendText: async (chatId, text) => bridge?.sendText(chatId, text) ?? null,
		rawClient: () => bridge?.rawClient() ?? null,
		active: () => followed && !!bridge,
	};

	/** 停止心跳与轮询定时器 */
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

	/** claim + 心跳 + pending 轮询（无 WS） */
	async function followOn(ctx: CommandCtx) {
		if (!credentials || !config.chatId) {
			ctx.ui.notify(
				"⚠️ pi-feishu 未激活：请设置环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET，" +
					"并在 settings.json 的 feishu.chatId 配置目标群 chat_id",
				"warning",
			);
			return;
		}
		if (followed) {
			ctx.ui.notify(`已 follow（会话名: ${sessionName}）`, "info");
			return;
		}

		selfSessionId = process.env.PI_SESSION_ID ?? "";
		const taken = getChatClaims(config.chatId).map((e) => e.sessionName);
		sessionName = config.sessionName ?? generateSessionName(process.cwd(), taken);
		addClaim(config.chatId, {
			sessionId: selfSessionId,
			sessionName,
			claimedAt: Date.now(),
			heartbeat: Date.now(),
		});

		bridge = new FeishuBridgeClient({ credentials, logger: log });
		await bridge.ensureClient(); // 出站 REST 客户端初始化

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

		// pending 轮询：~2s 读自己的指令文件 → 删 → 本地注入
		pollTimer = setInterval(() => {
			try {
				const pending = consumePending(selfSessionId);
				if (pending) {
					injectFeishuCommand(pi, state, pending.command, pending.senderOpenId);
				}
			} catch {
				// 轮询异常不致命
			}
		}, POLL_INTERVAL_MS);

		followed = true;
		ctx.ui.notify(`✅ 飞书已 follow（会话名: ${sessionName}），等待网关分发`, "info");
	}

	/** 释放 claim 并停止心跳/轮询 */
	async function followOff(ctx: CommandCtx) {
		if (!followed) {
			ctx.ui.notify("当前未 follow", "info");
			return;
		}
		removeClaim(config.chatId, selfSessionId);
		clearPending(selfSessionId);
		stopTimers();
		followed = false;
		ctx.ui.notify(`已停止 follow（会话名: ${sessionName}）`, "info");
	}

	// ── 事件 ctx 跟踪（isIdle 用） ──
	const trackCtx = (_e: unknown, ctx: ExtensionContext) => {
		liveCtx = ctx;
	};
	pi.on("agent_start", trackCtx);
	pi.on("message_end", trackCtx);
	pi.on("agent_end", trackCtx);
	pi.on("session_start", trackCtx);

	// ── 命令 ──
	pi.registerCommand("feishu-follow", {
		description: "管理飞书桥绑定。用法: /feishu-follow on|off|status",
		handler: async (args: string, ctx) => {
			const sub = args.trim() || "status";
			if (sub === "on") await followOn(ctx);
			else if (sub === "off") await followOff(ctx);
			else {
				const claims = config.chatId ? getChatClaims(config.chatId) : [];
				ctx.ui.notify(
					`飞书桥状态: ${followed ? "✅ follow 中" : "未 follow"}\n` +
						`本会话名: ${sessionName || "（未命名）"}\n` +
						`该群 follow 会话:\n${claims
							.map((e) => `- ${e.sessionName}（${isAlive(e) ? "心跳存活" : "离线"}）`)
							.join("\n") || "- （无）"}`,
					"info",
				);
			}
		},
	});

	pi.registerCommand("feishu-name", {
		description: "修改飞书会话名。用法: /feishu-name <new-name>",
		handler: async (args: string, ctx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(`当前会话名: ${sessionName || "（未命名）"}`, "info");
				return;
			}
			const conflict = config.chatId
				? getChatClaims(config.chatId).some(
						(e) => e.sessionName === name && e.sessionId !== selfSessionId,
					)
				: false;
			if (conflict) {
				ctx.ui.notify(`会话名 "${name}" 已被占用`, "warning");
				return;
			}
			if (followed && config.chatId) {
				// 改名保留原 claimedAt 与心跳
				const existing = getChatClaims(config.chatId).find(
					(e) => e.sessionId === selfSessionId,
				);
				addClaim(config.chatId, {
					sessionId: selfSessionId,
					sessionName: name,
					claimedAt: existing?.claimedAt ?? Date.now(),
					heartbeat: Date.now(),
				});
			}
			sessionName = name;
			ctx.ui.notify(`会话名已改为: ${name}`, "info");
		},
	});

	// ── 网关生命周期命令（实现在 lib/gateway/commands.ts） ──
	pi.registerCommand("feishu-gateway", {
		description: "管理飞书网关进程。用法: /feishu-gateway on|off|status",
		handler: async (args: string, ctx) => {
			const sub = args.trim() || "status";
			if (sub === "on") gatewayOn(ctx, !!credentials);
			else if (sub === "off") gatewayOff(ctx);
			else gatewayStatus(ctx, config.chatId ? getChatClaims(config.chatId) : []);
		},
	});

	// ── 出站播报 ──
	pi.on("agent_end", (event: unknown) => handleAgentEnd(state, event, log));

	// ask-user 等待提醒（agent_end 在该场景不触发）
	pi.events.on("rpiv:ask-user:prompt", (data: unknown) =>
		handleAskUserPrompt(state, data, log),
	);

	// 会话结束释放
	pi.on("session_shutdown", () => {
		if (followed) {
			try {
				if (config.chatId) removeClaim(config.chatId, selfSessionId);
				clearPending(selfSessionId);
			} catch {
				// ignore
			}
			stopTimers();
			followed = false;
		}
	});
};
