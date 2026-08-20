/**
 * pending 分发 — 轮询消费后的指令分发（代答 / 文本注入）
 * 从 session-follow.ts 提取（保持 follow 控制器专注启停生命周期）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { consumeAskUserAnswer, injectFeishuCommand, type HandlerState } from "./handlers";
import type { PendingCommand } from "./pending";

/** 分发单条 pending：ask-user-answer 走程序化回填，其余走文本注入 */
export function dispatchPending(
	pi: ExtensionAPI,
	state: HandlerState,
	pending: PendingCommand,
	log: (msg: string) => void,
): void {
	if (pending.kind === "ask-user-answer") {
		void consumeAskUserAnswer(state, pending.answerIndex ?? 0, pending.senderOpenId, log);
	} else {
		injectFeishuCommand(pi, state, pending.command, pending.senderOpenId);
	}
}
