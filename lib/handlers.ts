/**
 * 事件处理器 — pending 轮询注入、agent_end 播报、ask-user 提醒
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FeishuConfig } from "./types";
import {
	broadcastAskWaiting,
	broadcastReply,
	buildAskWaitingBody,
	summarizeQuestions,
	type AskPromptQuestion,
} from "./broadcast";
import { appendOutbox } from "./outbox";
import { parseAnswerSpec, type AnswerSpecItem, type AnswerSpecQuestion } from "./answer-spec";

/** isIdle 安全调用（ctx 可能随会话销毁失效） */
export function safeIsIdle(ctx: unknown): boolean {
	try {
		return Boolean((ctx as { isIdle?: () => boolean })?.isIdle?.());
	} catch {
		return true;
	}
}

export interface HandlerState {
	selfSessionId: string;
	sessionName: () => string;
	config: FeishuConfig;
	botOpenId: () => string | null;
	liveCtx: () => unknown;
	/** 出站写 outbox（网关发送） */
	appendOutboxFn: (typeof appendOutbox) | null;
	/** 是否处于 follow（激活）状态 */
	active: () => boolean;
}

export interface BroadcastLike {
	im: { message: { create: (args: unknown) => Promise<unknown> } };
}

/** pending 指令注入本会话（网关路由命中后由轮询器调用）。
 * 双闸校验（@bot + 白名单）已在网关单点执行，此处不重复也不绕过。 */
export function injectFeishuCommand(
	pi: ExtensionAPI,
	state: HandlerState,
	command: string,
	senderOpenId: string,
): void {
	const content = `**飞书指令**（来自 ${senderOpenId.slice(0, 10)}…）:\n\n${command}`;
	// 忙闲分流：闲时 triggerTurn 新回合，忙时 steer 插话
	// （isIdle 在事件 ctx 上，不在 pi 上 — pi-intercom index.ts L941 同款）
	const idle = safeIsIdle(state.liveCtx());
	if (idle) {
		pi.sendMessage(
			{ customType: "feishu_message", content, display: true },
			{ triggerTurn: true },
		);
	} else {
		pi.sendMessage(
			{ customType: "feishu_message", content, display: true },
			{ deliverAs: "steer" },
		);
	}
}

/** 从 agent_end 事件提取最后一条 assistant 消息的纯文本 */
export function extractAssistantText(event: unknown): string {
	const messages =
		(event as { messages?: Array<{ role?: string; content?: unknown }> })
			.messages ?? [];
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	if (!last) return "";
	const content = last.content as unknown;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(c): c is { type: "text"; text: string } =>
				(c as { type?: string })?.type === "text",
		)
		.map((c) => c.text)
		.join("\n");
}

/** agent_end 播报回调 */
export function handleAgentEnd(
	state: HandlerState,
	event: unknown,
	logger?: (msg: string) => void,
): void {
	if (!state.active()) return;
	const text = extractAssistantText(event);
	if (!text.trim()) return;
	void broadcastReply(
		{ sessionId: state.selfSessionId, config: state.config, logger },
		state.sessionName(),
		text,
	);
}

/** rpiv:ask-user:prompt 等待提醒回调：附选项列表 + answer 用法提示 */
export function handleAskUserPrompt(
	state: HandlerState,
	data: unknown,
	logger?: (msg: string) => void,
): void {
	if (!state.active()) return;
	const payload = data as { questions?: AskPromptQuestion[] };
	const questions = payload.questions ?? [];
	const body = buildAskWaitingBody(state.sessionName(), questions);
	void broadcastAskWaiting(
		{ sessionId: state.selfSessionId, config: state.config, logger },
		state.sessionName(),
		body,
	);
}

/** fork 包在 globalThis 上注册的 API 入口（无依赖消费） */
function askUserApi(): {
	getActiveAskParams: () => { questions?: AnswerSpecQuestion[] } | null;
	submitAskUserAnswer: (r: {
		answers: AnswerSpecItem[];
		cancelled: boolean;
	}) => boolean;
} | null {
	const s = globalThis as Record<symbol, unknown>;
	return (
		(s[Symbol.for("@pi-atelier/rpiv-ask-user/api")] as ReturnType<typeof askUserApi>) ?? null
	);
}

/** 消费 ask-user-answer pending：程序化回填问卷（幂等失败 → 播报过期）。
 * answerSpec 支持多题（逗号分隔）、多选（|）、自定义（=文本），单数字向后兼容。 */
export async function consumeAskUserAnswer(
	state: HandlerState,
	answerSpec: string,
	senderOpenId: string,
	logger?: (msg: string) => void,
): Promise<void> {
	const append = state.appendOutboxFn;
	const reply = (text: string): void => {
		if (!append) return;
		append(state.selfSessionId, {
			kind: "reply",
			text: `[pi:${state.sessionName()}] ${text}`,
			expectAck: false,
		});
	};
	const api = askUserApi();
	const params = api?.getActiveAskParams();
	if (!api || !params?.questions?.length) {
		reply("问卷已答复或已过期");
		return;
	}
	const questions = params.questions;
	const parsed = parseAnswerSpec(answerSpec, questions);
	if (typeof parsed === "string") {
		reply(parsed);
		return;
	}
	const ok = api.submitAskUserAnswer({ answers: parsed, cancelled: false });
	if (ok) {
		logger?.(
			`[pi-feishu] ask-user 已由 ${senderOpenId.slice(0, 10)}… 代答: ${answerSpec}`,
		);
		reply(`✅ 已代答: ${answerSpec}`);
	} else {
		reply("问卷已答复或已过期");
	}
}
