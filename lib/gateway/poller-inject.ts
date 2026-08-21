/**
 * 拉取消息注入（feishu-poll-primary D3）— Poller 回调 → 路由判定 → 同窗合并 → 写 pending + 回执
 * 独立于 main.ts（闭包依赖以参数注入，可测）。
 */

import { parsePolledMessage, type PolledMessageItem } from "../events";
import { resolveRoute, gatewayRoute, type GatewayRouteDeps } from "./route";
import { groupForMerge, mergeTexts, type MessageIdDedup } from "./poller-core";
import type { PendingCommand } from "../pending";

export interface PollerInjectDeps extends GatewayRouteDeps {
	/** bot open_id（@bot 检测） */
	botOpenId: string;
	chatId: string;
	/** 双键去重（与 WS 共用） */
	dedup: MessageIdDedup;
	/** 写 pending（与 GatewayRouteDeps.writePending 相同签名） */
	writePending: (sessionId: string, data: PendingCommand) => void;
	reply: (text: string, anchorSessionId?: string) => void;
	log: (msg: string) => void;
}

/**
 * 拉取消息批处理（T1.3）：
 * - message_id 去重（WS 已处理的命令跳过）
 * - bot 自消息/其他群跳过
 * - 命令类逐条独立路由（gatewayRoute）
 * - 转交型按目标会话分组合并（文本换行拼接 + 条数标注；awr 代答保留语义独立注入）
 */
export function injectPolledItems(
	items: PolledMessageItem[],
	deps: PollerInjectDeps,
	now: number = Date.now(),
): void {
	const decisions = [];
	for (const item of items) {
		if (item.chat_id !== deps.chatId) continue;
		if (deps.dedup.has(item.message_id)) {
			deps.log(`拉取跳过（WS 已处理）: ${item.message_id}`);
			continue;
		}
		deps.dedup.add(item.message_id);
		const parsed = parsePolledMessage(item, deps.botOpenId);
		if (parsed.isSelfMessage) continue; // bot 自消息过滤
		const decision = resolveRoute(parsed, deps);
		decisions.push({ parsed, decision });
	}
	const { commands, merged } = groupForMerge(decisions);
	// 命令类：逐条独立路由（list / 不在线提示等，复用 gatewayRoute 副作用）
	for (const c of commands) {
		gatewayRoute(deps, c.parsed, now);
	}
	// 转交型：按目标会话合并注入
	for (const group of merged) {
		const first = group.entries[0];
		const target = deps.claims.find((e) => e.sessionId === group.targetSessionId);
		if (!target) {
			// 路由判定与注入之间 claim 可能下线：降级逐条走 gatewayRoute（会回复不在线列表）
			for (const entry of group.entries) gatewayRoute(deps, entry.parsed, now);
			continue;
		}
		// awr 代答保留语义独立注入；普通转交合并为一条
		const plain = [];
		for (const entry of group.entries) {
			if (entry.decision.kind === "transfer" && entry.decision.answerSpec) {
				writeAnswerPending(deps, group.targetSessionId, entry.parsed.text, entry.decision.answerSpec, now);
			} else {
				plain.push(
					(entry.decision.kind === "transfer" && entry.decision.commandText
						? entry.decision.commandText
						: entry.parsed.text).trim() || "（空指令，请继续）",
				);
			}
		}
		if (plain.length > 0) {
			const text = mergeTexts(plain);
			deps.writePending(group.targetSessionId, {
				command: text,
				senderOpenId: first.parsed.senderOpenId ?? "unknown",
				arrivedAt: now,
				id: `pf-${now}-${Math.random().toString(36).slice(2, 8)}`,
			});
			deps.reply(
				plain.length > 1 ? `已转交 ${target.sessionName}（合并 ${plain.length} 条）` : `已转交 ${target.sessionName}`,
				group.targetSessionId,
			);
		}
	}
}

function writeAnswerPending(
	deps: PollerInjectDeps,
	sessionId: string,
	rawText: string,
	answerSpec: string,
	now: number,
): void {
	deps.writePending(sessionId, {
		command: rawText,
		senderOpenId: "unknown",
		arrivedAt: now,
		id: `pf-${now}-${Math.random().toString(36).slice(2, 8)}`,
		kind: "ask-user-answer",
		answerSpec,
		...( /^\d+$/.test(answerSpec) ? { answerIndex: Number(answerSpec) } : {} ),
	});
}
