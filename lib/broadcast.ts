/**
 * 出站播报 — agent_end 回复推送、ask-user 等待提醒、长回复截断+文档导出
 * 全双工架构：出站一律写 outbox（网关发送），会话侧纯本地文件 IO，
 * 不再直连飞书 REST（凭据只在网关进程）。
 */

import { buildDocTitle, truncateForChat } from "./doc";
import { appendOutbox } from "./outbox";
import type { FeishuConfig } from "./types";

/** outbox 条目构造参数（去 id/createdAt） */
export type OutboxAppend = Parameters<typeof appendOutbox>[1];

export interface BroadcastDeps {
	config: FeishuConfig;
	/** 会话 id（outbox 文件名） */
	sessionId: string;
	logger?: (msg: string) => void;
	/** 测试注入用 */
	append?: typeof appendOutbox;
}

export interface BroadcastResult {
	/** 已写入 outbox 即视为已受理（发送由网关异步完成） */
	sent: boolean;
	truncated: boolean;
}

function append(deps: BroadcastDeps, entry: OutboxAppend): void {
	(deps.append ?? appendOutbox)(deps.sessionId, entry);
}

/**
 * 播报 AI 回复到群：带会话名前缀；超阈值截断 + 全文经网关写飞书文档。
 * 出站写 outbox（fire-and-forget），不感知发送结果。
 */
export function broadcastReply(
	deps: BroadcastDeps,
	sessionName: string,
	replyText: string,
): BroadcastResult {
	const { config } = deps;
	const prefix = `[pi:${sessionName}]`;
	const threshold = config.truncateThreshold;

	if (replyText.length <= threshold) {
		append(deps, {
			kind: "reply",
			text: `${prefix}\n${replyText}`,
			expectAck: false,
		});
		return { sent: true, truncated: false };
	}

	// 长回复：doc-export 条目（网关侧导出文档 + 追加链接）
	const summary = truncateForChat(replyText, threshold);
	append(deps, {
		kind: "doc-export",
		text: `${prefix}\n${summary}`,
		expectAck: false,
		docTitle: buildDocTitle(sessionName, replyText),
		docText: replyText,
	});
	return { sent: true, truncated: true };
}

/** 等待输入提醒（rpiv:ask-user:prompt）— text 为去掉会话名前缀的正文 */
export function broadcastAskWaiting(
	deps: BroadcastDeps,
	sessionName: string,
	text: string,
): boolean {
	append(deps, {
		kind: "ask-waiting",
		text: `[pi:${sessionName}] ⏸ 等待输入: ${text}`,
		expectAck: false,
	});
	return true;
}

/** 从 questions payload 生成带选项列表的提醒正文（不含前缀） */
export function buildAskWaitingBody(
	sessionName: string,
	questions: AskPromptQuestion[],
): string {
	const first = questions.find((q) => q.question);
	if (!first?.options?.length) return summarizeQuestions(questions);
	const header = first.header ? `[${first.header}] ` : "";
	const q0 = first.question!.slice(0, 80);
	const lines: string[] = [`${header}${q0}`];

	if (questions.length === 1) {
		for (let i = 0; i < first.options!.length; i++) {
			const o = first.options![i];
			const desc = o.description ? ` — ${o.description}` : "";
			lines.push(`${i + 1}. ${o.label}${desc}`);
		}
		lines.push(`回复 @bot ${sessionName} awr <编号> 选择`);
	} else {
		for (let qi = 0; qi < questions.length; qi++) {
			const q = questions[qi];
			if (!q.question) continue;
			lines.push(`问题${qi + 1}: ${q.question.slice(0, 60)}`);
			for (let i = 0; i < (q.options?.length ?? 0); i++) {
				lines.push(`  ${qi + 1}.${i + 1} ${q.options![i]!.label}`);
			}
		}
		lines.push("⚠️ 多题暂不支持飞书应答，请回终端操作");
	}
	return lines.join("\n");
}

/** ask-user 提醒 payload 中的问题结构 */
export interface AskPromptOption {
	label: string;
	description?: string;
	hasPreview?: boolean;
}

export interface AskPromptQuestion {
	question?: string;
	header?: string;
	multiSelect?: boolean;
	options?: AskPromptOption[];
}

/** 从 questions payload 生成问题摘要（首个问题的 question 截断） */
export function summarizeQuestions(
	questions: Array<{ question?: string; header?: string }>,
): string {
	const first = questions.find((q) => q.question);
	if (!first) return "AI 正在等待你的选择";
	const q = first.question!.slice(0, 80);
	const header = first.header ? `[${first.header}] ` : "";
	return `${header}${q}`;
}
