/**
 * 网关路由 — 网关侧入站决策（纯函数，可测）
 * 复用 events.ts 的解析与白名单原语，双闸 invariant 单点执行。
 */

import type { ClaimEntry } from "../types";
import { isWhitelisted, parseCommand } from "../events";

export interface GatewayRouteDeps {
	/** 该群全部 claim（心跳判活由调用方或本函数完成） */
	claims: ClaimEntry[];
	whitelist: string[];
	/** 写入目标会话的 pending 文件 */
	writePending: (sessionId: string, data: { command: string; senderOpenId: string; arrivedAt: number; id: string }) => void;
	/** 回复群消息 */
	reply: (text: string) => void;
}

export type GatewayRouteAction =
	| "ignored"          // 未 @bot / 自环 / 白名单拒绝 / 空文本
	| "handled_list"     // list 由网关回复
	| "routed"           // 写 pending + 回执
	| "not_found_reply"; // 目标不在线，网关回复在线列表

/** 网关侧路由决策（复用 events.ts 原语，会话侧 routeInbound 的网关版） */
export function gatewayRoute(
	deps: GatewayRouteDeps,
	parsed: {
		mentionedBot: boolean;
		senderOpenId: string | null;
		isSelfMessage: boolean;
		text: string;
	},
	now: number = Date.now(),
): GatewayRouteAction {
	if (parsed.isSelfMessage) return "ignored";
	if (!parsed.mentionedBot) return "ignored";
	if (!isWhitelisted(parsed.senderOpenId, deps.whitelist)) return "ignored";

	const text = parsed.text.trim();
	if (!text) return "ignored";

	const live = deps.claims;

	if (text === "list" || text === "list 会话") {
		deps.reply(
			`[pi] 在线会话:\n${live.map((e) => `- ${e.sessionName}`).join("\n") || "-（无）"}`,
		);
		return "handled_list";
	}

	const cmd = parseCommand(text);
	if (!cmd) return "ignored";

	const target = live.find((e) => e.sessionName === cmd.sessionName);
	if (!target) {
		deps.reply(
			`[pi] 会话 "${cmd.sessionName}" 不在线。当前在线:\n${live.map((e) => `- ${e.sessionName}`).join("\n") || "-（无）"}`,
		);
		return "not_found_reply";
	}

	deps.writePending(target.sessionId, {
		command: cmd.command || "（空指令，请继续）",
		senderOpenId: parsed.senderOpenId ?? "unknown",
		arrivedAt: now,
		id: `pf-${now}-${Math.random().toString(36).slice(2, 8)}`,
	});
	deps.reply(`已转交 ${target.sessionName}`);
	return "routed";
}
