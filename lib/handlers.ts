/**
 * 事件处理器 — pending 轮询注入、agent_end 播报、ask-user 提醒
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FeishuConfig } from "./types";
import {
	broadcastAskWaiting,
	broadcastReply,
	summarizeQuestions,
} from "./broadcast";

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
	sendText: (chatId: string, text: string) => Promise<string | null>;
	rawClient: () => unknown;
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
	const raw = state.rawClient();
	void broadcastReply(
		{
			client: raw as never,
			getDocClient: () => raw as never,
			config: state.config,
			logger,
		},
		state.sessionName(),
		text,
	);
}

/** rpiv:ask-user:prompt 等待提醒回调 */
export function handleAskUserPrompt(
	state: HandlerState,
	data: unknown,
	logger?: (msg: string) => void,
): void {
	if (!state.active()) return;
	const payload = data as {
		questions?: Array<{ question?: string; header?: string }>;
	};
	const summary = summarizeQuestions(payload.questions ?? []);
	void broadcastAskWaiting(
		{
			client: state.rawClient() as never,
			getDocClient: () => null,
			config: state.config,
			logger,
		},
		state.sessionName(),
		summary,
	);
}
