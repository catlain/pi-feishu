/**
 * 入站路由 — @bot 指令分发到对应会话
 */

import type { ClaimEntry } from "./types";
import { isWhitelisted, parseCommand } from "./events";

export interface RouteDeps {
	chatId: string;
	/** 该群存活（follow 中）的 claim 会话 */
	liveClaims: ClaimEntry[];
	/** 本会话的 sessionId */
	selfSessionId: string;
	/** 本会话是否为该群主会话（最早 claim 且存活） */
	isPrimary: boolean;
	whitelist: string[];
	/** 注入指令到目标会话（本进程内只有自己可注入；跨进程交给各会话自己的 WS 处理） */
	injectSelf: (command: string, fromName: string) => void;
	/** 回复群消息 */
	reply: (text: string) => Promise<void>;
}

export interface RouteResult {
	action:
		| "ignored"           // 未 @bot / 自环 / 白名单拒绝
		| "handled_list"      // 本会话处理了 list 指令
		| "injected"          // 指令注入本会话
		| "silent"            // 指令目标不是本会话，静默
		| "not_found_reply";  // 目标不存在，本会话回复在线列表
}

/**
 * 入站处理决策（纯函数，可测）。
 * 双闸：mentionedBot && isWhitelisted 由调用方已完成校验后才进入本函数？
 * 不 — 本函数接收原始解析结果统一决策，保证 invariant 单点。
 */
export function routeInbound(
	deps: RouteDeps,
	parsed: {
		mentionedBot: boolean;
		senderOpenId: string | null;
		isSelfMessage: boolean;
		text: string;
	},
): RouteResult {
	// 自环防护：bot 自己的消息一律忽略
	if (parsed.isSelfMessage) return { action: "ignored" };
	// 双闸 invariant：@bot + 白名单（空名单默认拒绝）
	if (!parsed.mentionedBot) return { action: "ignored" };
	if (!isWhitelisted(parsed.senderOpenId, deps.whitelist)) return { action: "ignored" };

	const text = parsed.text.trim();
	if (!text) return { action: "ignored" };

	// list 指令：主会话仲裁回复
	if (text === "list" || text === "list 会话") {
		if (!deps.isPrimary) return { action: "silent" };
		const names = deps.liveClaims.map((e) => e.sessionName);
		void deps.reply(`[pi] 在线会话:\n${names.map((n) => `- ${n}`).join("\n") || "-（无）"}`);
		return { action: "handled_list" };
	}

	const cmd = parseCommand(text);
	if (!cmd) return { action: "ignored" };

	const target = deps.liveClaims.find((e) => e.sessionName === cmd.sessionName);

	if (!target) {
		// 目标不存在：主会话回复在线列表，非主会话静默（避免 N 条重复）
		if (!deps.isPrimary) return { action: "silent" };
		const names = deps.liveClaims.map((e) => e.sessionName);
		void deps.reply(
			`[pi] 会话 "${cmd.sessionName}" 不在线。当前在线:\n${names.map((n) => `- ${n}`).join("\n") || "-（无）"}`,
		);
		return { action: "not_found_reply" };
	}

	// 目标是本会话 → 注入；否则本会话的 WS 也收到了但静默
	if (target.sessionId !== deps.selfSessionId) return { action: "silent" };
	deps.injectSelf(cmd.command || "（空指令，请继续）", parsed.senderOpenId ?? "unknown");
	return { action: "injected" };
}
