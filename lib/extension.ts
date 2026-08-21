/**
 * 扩展主体 — 命令/事件注册（薄壳）
 * 会话侧为薄客户端：claim + 心跳 + pending 轮询 + 出站播报。
 * 入站 WS / 路由全部在网关进程（lib/gateway/main.ts）。
 */

import type { ExtensionFactory, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getFeishuConfig } from "./config";
import { getCredentials } from "./credentials";
import { getChatClaims, isAlive } from "./claim";
import { appendOutbox } from "./outbox";
import { gatewayOn, gatewayOff, gatewayStatus, gatewayInterval } from "./gateway/commands";
import { createFollowController, type CommandCtx } from "./session-follow";
import {
	handleAgentEnd,
	handleAskUserPrompt,
	type HandlerState,
} from "./handlers";

export const createFeishuExtension: ExtensionFactory = (pi) => {
	const config = getFeishuConfig(process.cwd());
	const credentials = getCredentials(config);

	/** 最近一次事件 ctx（isIdle 判断需要） */
	let liveCtx: ExtensionContext | null = null;
	/** 出站激活标记：follow on 时置 true（出站走 outbox，无需 client） */
	let outboundActive = false;

	const log = (msg: string) => {
		try {
			pi.events.emit("pi-feishu:log", { msg });
		} catch {
			// ignore
		}
	};

	const state: HandlerState = {
		get selfSessionId() {
			return process.env.PI_SESSION_ID ?? "";
		},
		sessionName: () => follow.sessionName(),
		config,
		botOpenId: () => null,
		liveCtx: () => liveCtx,
		appendOutboxFn: appendOutbox,
		active: () => follow.followed() && outboundActive,
	};

	const follow = createFollowController(pi, {
		config,
		log,
		state,
		getSelfSessionId: () => process.env.PI_SESSION_ID ?? "",
		setOutboundActive: (v: boolean) => {
			outboundActive = v;
		},
	});

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
		handler: async (args: string, ctx: CommandCtx) => {
			const sub = args.trim() || "status";
			if (sub === "on") await follow.on(ctx);
			else if (sub === "off") await follow.off(ctx);
			else {
				const claims = config.chatId ? getChatClaims(config.chatId) : [];
				ctx.ui.notify(
					`飞书桥状态: ${follow.followed() ? "✅ follow 中" : "未 follow"}\n` +
						`本会话名: ${follow.sessionName() || "（未命名）"}\n` +
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
		handler: async (args: string, ctx: CommandCtx) => {
			const name = args.trim();
			if (!name) {
				ctx.ui.notify(`当前会话名: ${follow.sessionName() || "（未命名）"}`, "info");
				return;
			}
			ctx.ui.notify(
				`改名功能已迁移：请用 /feishu-name 由 follow 控制器处理（实现见 session-follow）`,
				"info",
			);
			follow.rename(ctx, name);
		},
	});

	// ── 网关生命周期命令（实现在 lib/gateway/commands.ts） ──
	pi.registerCommand("feishu-gateway", {
		description:
			"管理飞书网关进程。用法: /feishu-gateway on|off|status|interval <秒>",
		handler: async (args: string, ctx: CommandCtx) => {
			const trimmed = args.trim();
			const [sub, ...rest] = trimmed.split(/\s+/);
			if (sub === "on") gatewayOn(ctx, !!credentials);
			else if (sub === "off") gatewayOff(ctx);
			else if (sub === "interval") gatewayInterval(ctx, rest[0] ?? "");
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
	pi.on("session_shutdown", () => follow.shutdown());
};
