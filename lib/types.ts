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
	/** 飞书自建应用凭证（主配置方式，与其他包配置项风格一致） */
	appId?: string;
	appSecret?: string;
}

export interface ClaimEntry {
	sessionId: string;
	sessionName: string;
	claimedAt: number;
	/** 最近心跳时间戳（30s 一跳；>60s 无更新视为离线）。旧 claim 无此字段时回退 claimedAt */
	heartbeat?: number;
}

export type ClaimFile = Record<string, ClaimEntry[]>;

/** mention 条目（实测在 data.message.mentions） */
export interface FeishuMention {
	key?: string;
	id?: { open_id?: string; user_id?: string };
	name?: string;
	mentioned_type?: string;
	tenant_key?: string;
}

/** 飞书 im.message.receive_v1 事件体（只声明用到的字段）
 * 实测（2026-06-20 dump）：mentions 在 message 层、chat_id 在 message 层、
 * sender 在顶层 —— 各字段位置不同，兼容两种位置 */
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
		mentions?: FeishuMention[];
	};
	sender?: {
		sender_type?: string;
		sender_id?: { open_id?: string };
	};
	chat?: { chat_id?: string };
	/** 兼容：部分事件版本在顶层 */
	mentions?: FeishuMention[];
}

/** 出站条目回执（网关发送后回写） */
export interface OutboxResult {
	sent: boolean;
	/** 飞书 message_id */
	messageId?: string;
	/** doc-export 类导出的文档链接 */
	docUrl?: string;
	/** 发送/导出失败原因（回写后不再重试） */
	error?: string;
}

/** 出站条目 — outbox/<sessionId>.json FIFO 数组元素 */
export interface OutboxEntry {
	/** 唯一 id */
	id: string;
	/** reply | ask-waiting | topic-head | doc-export */
	kind: "reply" | "ask-waiting" | "topic-head" | "doc-export";
	/** 会话侧写时间戳 */
	createdAt: number;
	/** 发送正文（doc-export 为摘要正文，链接由网关追加） */
	text: string;
	/** 需回执：网关发送后回写 result，会话读取后删除 */
	expectAck: boolean;
	/** 网关回写的回执（未发送时缺省） */
	result?: OutboxResult;
	/** kind=doc-export 时：文档标题 */
	docTitle?: string;
	/** kind=doc-export 时：文档全文 */
	docText?: string;
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
