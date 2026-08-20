/**
 * 飞书事件解析工具
 * 已知坑：
 * - sender 在顶层 data.sender（不在 message 里）
 * - @ 提及在 text 里是占位符（@_user_1），真实判断查 mentions 数组
 */

import type { FeishuMessageEvent, ParsedInbound } from "./types";

/** 消息 text 中去除 @占位符后的正文 */
export function stripMentionPlaceholders(text: string): string {
	return text.replace(/@_user_\d+/g, "").trim();
}

/** 解析 message.content JSON 中的 text 字段 */
export function extractText(content: string | undefined): string {
	if (!content) return "";
	try {
		const parsed = JSON.parse(content);
		return typeof parsed?.text === "string" ? parsed.text : "";
	} catch {
		return "";
	}
}

/**
 * 解析入站事件。
 * botOpenId：本 bot 的 open_id（mentions 匹配用）。
 * 实测（2026-06-20 事件 dump）：mentions 在 data.message.mentions，chat_id 在 data.message.chat_id，
 * sender 在顶层 data.sender —— 各字段位置不同，逐字段兼容两层。
 */
export function parseInboundEvent(
	data: FeishuMessageEvent,
	botOpenId: string,
): ParsedInbound {
	// 自环：sender_type 为 app 的是 bot 自己发的
	const senderType = data.sender?.sender_type ?? data.message?.sender?.sender_type;
	const isSelfMessage = senderType === "app";

	// sender open_id 优先顶层 data.sender.sender_id.open_id
	const senderOpenId =
		data.sender?.sender_id?.open_id ??
		data.message?.sender?.sender_id?.open_id ??
		null;

	// @bot 检测：mentions 数组匹配 bot open_id（不依赖 text 字符串）。
	// mentions 实际在 message 层，兼容顶层
	const mentions = data.message?.mentions ?? data.mentions ?? [];
	const mentionedBot = mentions.some((m) => m.id?.open_id === botOpenId);

	// chat_id 实际在 message 层，兼容顶层
	const chatId = data.message?.chat_id ?? data.chat?.chat_id ?? null;
	const text = stripMentionPlaceholders(extractText(data.message?.content));
	const eventTimeMs = data.message?.create_time ? Number(data.message.create_time) : null;

	// 引用回复：parent_id 指向被引用消息（锚点路由用）
	const parentId = data.message?.parent_id ?? null;

	return {
		mentionedBot,
		senderOpenId,
		isSelfMessage,
		chatId,
		text,
		eventTimeMs: Number.isFinite(eventTimeMs) ? eventTimeMs : null,
		parentId,
	};
}

/** 白名单校验：open_id 精确匹配，空名单默认拒绝 */
export function isWhitelisted(
	senderOpenId: string | null,
	whitelist: string[],
): boolean {
	if (!senderOpenId || whitelist.length === 0) return false;
	return whitelist.includes(senderOpenId);
}

/**
 * 解析指令：首词为会话名，剩余为指令内容。
 * 返回 null 表示不是"名字+指令"格式（只有 list 等全局指令时）。
 */
export function parseCommand(
	text: string,
): { sessionName: string; command: string } | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	const spaceIdx = trimmed.search(/\s/);
	if (spaceIdx < 0) return { sessionName: trimmed, command: "" };
	return {
		sessionName: trimmed.slice(0, spaceIdx),
		command: trimmed.slice(spaceIdx).trim(),
	};
}
