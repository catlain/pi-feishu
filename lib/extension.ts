/**
 * 扩展主体 — 状态管理 + 命令/事件注册
 * 逻辑在 handlers.ts / claim.ts / route.ts 等可测模块中。
 */

import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getFeishuConfig } from "./config";
import { getCredentials } from "./credentials";
import { FeishuBridgeClient } from "./client";
import { addClaim, getChatClaims, removeClaim } from "./claim";
import { generateSessionName } from "./naming";
import {
	handleAgentEnd,
	handleAskUserPrompt,
	handleInbound,
	type HandlerState,
} from "./handlers";

/** 命令 ctx 的最小结构（notify 类型对齐 SDK：第二参数为字面量联合） */
type CommandCtx = {
	ui: { notify: (msg: string, type?: "info" | "error" | "warning") => void };
};

export const createFeishuExtension: ExtensionFactory = (pi) => {
	const config = getFeishuConfig(process.cwd());
	const credentials = getCredentials();

	let bridge: FeishuBridgeClient | null = null;
	let botOpenId: string | null = null;
	let followed = false;
	let sessionName = "";
	let selfSessionId = "";
	/** 最近一次事件 ctx（isIdle 判断需要；pi 上无 isIdle，参考 pi-intercom 用 ctx.isIdle()） */
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
		botOpenId: () => botOpenId,
		liveCtx: () => liveCtx,
		sendText: async (chatId, text) => bridge?.sendText(chatId, text) ?? null,
		rawClient: () => bridge?.rawClient() ?? null,
		active: () => followed && !!bridge,
	};

	/** 建立 WS 连接并 claim */
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
		});

		bridge = new FeishuBridgeClient({
			credentials,
			chatId: config.chatId,
			onEvent: (d) => handleInbound(pi, state, d),
			logger: log,
		});
		await bridge.connect();
		botOpenId = await bridge.fetchBotOpenId();
		followed = true;
		ctx.ui.notify(`✅ 飞书已连接，会话名: ${sessionName}`, "info");
	}

	/** 释放 claim 并断开 */
	async function followOff(ctx: CommandCtx) {
		if (!followed) {
			ctx.ui.notify("当前未 follow", "info");
			return;
		}
		removeClaim(config.chatId, selfSessionId);
		await bridge?.disconnect();
		bridge = null;
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
						`该群 follow 会话: ${claims.map((e) => e.sessionName).join(", ") || "（无）"}`,
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
				// 改名保留原 claimedAt（避免抢占主会话仲裁位）
				const existing = getChatClaims(config.chatId).find(
					(e) => e.sessionId === selfSessionId,
				);
				addClaim(config.chatId, {
					sessionId: selfSessionId,
					sessionName: name,
					claimedAt: existing?.claimedAt ?? Date.now(),
				});
			}
			sessionName = name;
			ctx.ui.notify(`会话名已改为: ${name}`, "info");
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
			} catch {
				// ignore
			}
			void bridge?.disconnect();
			followed = false;
		}
	});
};
