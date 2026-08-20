/**
 * 共享类型定义
 */

export interface FeishuConfig {
	/** 目标群 chat_id（从群里 @bot 消息事件获取） */
	chatId: string;
	/** 允许遥控的 sender open_id 白名单，空数组 = 默认拒绝所有 */
	whitelist: string[];
	/** 长回复截断阈值（字符），超过则截断 + 写飞书文档 */
	truncateThreshold: number;
	/** 会话名覆盖（不配置时默认取 cwd basename） */
	sessionName?: string;
}

export interface ClaimEntry {
	sessionId: string;
	sessionName: string;
	claimedAt: number;
}

export type ClaimFile = Record<string, ClaimEntry[]>;

/** 飞书 im.message.receive_v1 事件体（只声明用到的字段） */
export interface FeishuMessageEvent {
	message?: {
		message_id?: string;
		chat_id?: string;
		msg_type?: string;
		content?: string;
		sender?: {
			sender_type?: string;
			sender_id?: { open_id?: string };
		};
	};
	sender?: {
		sender_type?: string;
		sender_id?: { open_id?: string };
	};
	chat?: { chat_id?: string };
	mentions?: Array<{
		key?: string;
		id?: { open_id?: string; user_id?: string };
		name?: string;
		tenant_key?: string;
	}>;
}

/** 入站消息解析结果 */
export interface ParsedInbound {
	/** @ 了本 bot */
	mentionedBot: boolean;
	/** 发送者 open_id（优先顶层 data.sender） */
	senderOpenId: string | null;
	/** bot 自己发的消息（自环过滤） */
	isSelfMessage: boolean;
	/** chat_id */
	chatId: string | null;
	/** 提及后的剩余文本（已去除 @占位符） */
	text: string;
}
