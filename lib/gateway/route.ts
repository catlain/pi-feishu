/**
 * 网关路由 — 网关侧入站决策（纯函数，可测）
 * 复用 events.ts 的解析与白名单原语，双闸 invariant 单点执行。
 */

import type { ClaimEntry } from "../types";
import { isWhitelisted, parseCommand } from "../events";
import type { PendingCommand } from "../pending";
import { lookupAnchor } from "./anchors";

export interface GatewayRouteDeps {
	/** 该群全部 claim（心跳判活由调用方或本函数完成） */
	claims: ClaimEntry[];
	whitelist: string[];
	/** 写入目标会话的 pending 文件 */
	writePending: (sessionId: string, data: PendingCommand) => void;
	/** 回复群消息 */
	/** 回复；anchorSessionId 非空时该提示语也记为该会话的锦点（用户引用「已转交」可续聊） */
	reply: (text: string, anchorSessionId?: string) => void;
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
		/** 引用回复目标消息 id（锦点路由优先；非回复消息为 null） */
		parentId?: string | null;
	},
	now: number = Date.now(),
): GatewayRouteAction {
	if (parsed.isSelfMessage) return "ignored";
	if (!isWhitelisted(parsed.senderOpenId, deps.whitelist)) return "ignored";

	const text = parsed.text.trim();

	// ── 引用回复路由优先（D3）：免 @ 免名字直达 ──
	if (parsed.parentId) {
		const anchorSid = lookupAnchor(parsed.parentId);
		if (anchorSid) {
			// 判活联合判断（D2）：锚点管归属，claim 表管谁在线可路由
			const target = deps.claims.find((e) => e.sessionId === anchorSid);
			if (!target) {
				deps.reply(
					`[pi] 该会话已离线。当前在线:\n${deps.claims.map((e) => `- ${e.sessionName}`).join("\n") || "-（无）"}`,
				);
				return "not_found_reply";
			}
			// awr 代答在引用路由下同样直达（D5）；扩展语法：awr <答案串>（多题逗号、多选|、自定义=）
			const answerMatch = /^(?:awr|answer|代答)\s+(.+)$/.exec(text);
			if (answerMatch) {
				const answerSpec = answerMatch[1].trim();
				deps.writePending(anchorSid, {
					command: text,
					senderOpenId: parsed.senderOpenId ?? "unknown",
					arrivedAt: now,
					id: `pf-${now}-${Math.random().toString(36).slice(2, 8)}`,
					kind: "ask-user-answer",
					answerSpec,
					// 单数字旧格式双写 answerIndex（过渡期兼容，读迁移即删）
					...( /^\d+$/.test(answerSpec) ? { answerIndex: Number(answerSpec) } : {} ),
				});
				deps.reply(`已转交 ${target.sessionName} 代答 ${answerSpec}`, anchorSid);
				return "routed";
			}
			deps.writePending(anchorSid, {
				command: text || "（空指令，请继续）",
				senderOpenId: parsed.senderOpenId ?? "unknown",
				arrivedAt: now,
				id: `pf-${now}-${Math.random().toString(36).slice(2, 8)}`,
			});
			deps.reply(`已转交 ${target.sessionName}`, anchorSid);
			return "routed";
		}
		// 未命中的引用消息：仅当明确 @bot 才走名字路由，否则静默忽略
		if (!parsed.mentionedBot) return "ignored";
	}

	if (!parsed.mentionedBot) return "ignored";

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

	// 精确匹配 → 唯一前缀匹配（会话名都带随机后缀，输裸名即可命中）
	let target = live.find((e) => e.sessionName === cmd.sessionName);
	if (!target) {
		const candidates = live.filter(
			(e) => e.sessionName.startsWith(`${cmd.sessionName}-`),
		);
		if (candidates.length === 1) target = candidates[0];
		else if (candidates.length > 1) {
			deps.reply(
				`[pi] "${cmd.sessionName}" 匹配到多个会话，请用完整名或更长前缀:\n${candidates.map((e) => `- ${e.sessionName}`).join("\n")}`,
			);
			return "not_found_reply";
		}
	}
	if (!target) {
		deps.reply(
			`[pi] 会话 "${cmd.sessionName}" 不在线。当前在线:\n${live.map((e) => `- ${e.sessionName}`).join("\n") || "-（无）"}`,
		);
		return "not_found_reply";
	}

	// awr <答案串> / answer <答案串> / 代答 <答案串>：ask-user 问卷代答（会话侧程序化回填，不注入文本）
	// 答案串按题序逗号分隔：单选=选项号；多选=N|M；自定义==文本；单数字向后兼容旧语法
	const answerMatch = /^(?:awr|answer|代答)\s+(.+)$/.exec(cmd.command);
	if (answerMatch) {
		const answerSpec = answerMatch[1].trim();
		deps.writePending(target.sessionId, {
			command: cmd.command,
			senderOpenId: parsed.senderOpenId ?? "unknown",
			arrivedAt: now,
			id: `pf-${now}-${Math.random().toString(36).slice(2, 8)}`,
			kind: "ask-user-answer",
			answerSpec,
			// 单数字旧格式双写 answerIndex（过渡期兼容，读迁移即删）
			...( /^\d+$/.test(answerSpec) ? { answerIndex: Number(answerSpec) } : {} ),
		});
		deps.reply(`已转交 ${target.sessionName} 代答 ${answerSpec}`);
		return "routed";
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
