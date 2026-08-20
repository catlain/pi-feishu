/**
 * 出站播报 — agent_end 回复推送、ask-user 等待提醒、长回复截断+文档导出
 */

import {
	buildDocTitle,
	exportToDoc,
	truncateForChat,
} from "./doc";
import type { FeishuConfig } from "./types";

/** 发送文档能力（docx，可缺省） */
export interface DocxLike {
	docx: {
		document: { create: (args: unknown) => Promise<unknown> };
		documentBlock: { children: { create: (args: unknown) => Promise<unknown> } };
	};
}

/** 出站发送能力的最小结构类型（避免拉入完整 lark Client 类型） */
export interface ImLike {
	im: { message: { create: (args: unknown) => Promise<unknown> } };
}

export interface BroadcastDeps {
	client: ImLike;
	getDocClient: () => DocxLike | null;
	config: FeishuConfig;
	logger?: (msg: string) => void;
}

export interface BroadcastResult {
	sent: boolean;
	truncated: boolean;
	docUrl?: string;
	error?: string;
}

/**
 * 播报 AI 回复到群：带会话名前缀；超阈值截断 + 全文写飞书文档。
 * 发送/文档失败均静默降级，不抛出。
 */
export async function broadcastReply(
	deps: BroadcastDeps,
	sessionName: string,
	replyText: string,
): Promise<BroadcastResult> {
	const { config } = deps;
	const prefix = `[pi:${sessionName}]`;
	const threshold = config.truncateThreshold;

	if (replyText.length <= threshold) {
		const sent = await safeSendText(deps, config.chatId, `${prefix}\n${replyText}`);
		return { sent, truncated: false };
	}

	// 长回复：尝试文档导出
	const docClient = deps.getDocClient();
	let docUrl: string | undefined;
	let docError: string | undefined;
	if (docClient) {
		const title = buildDocTitle(sessionName, replyText);
		const result = await exportToDoc(docClient, title, replyText);
		if (result.ok) docUrl = result.url;
		else docError = result.error;
	}

	const summary = truncateForChat(replyText, threshold);
	let message = `${prefix}\n${summary}`;
	if (docUrl) message += `\n📄 全文: ${docUrl}`;
	else if (docError) message += `\n⚠️ 文档导出失败（${docError}）`;

	const sent = await safeSendText(deps, config.chatId, message);
	return { sent, truncated: true, docUrl, error: docError };
}

/** 等待输入提醒（rpiv:ask-user:prompt）— text 为去掉会话名前缀的正文 */
export async function broadcastAskWaiting(
	deps: BroadcastDeps,
	sessionName: string,
	text: string,
): Promise<boolean> {
	return safeSendText(deps, deps.config.chatId, `[pi:${sessionName}] ⏸ 等待输入: ${text}`);
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
		lines.push(`回复 @bot ${sessionName} <编号> 选择`);
	} else {
		for (let qi = 0; qi < questions.length; qi++) {
			const q = questions[qi];
			if (!q.question) continue;
			lines.push(`问题${qi + 1}: ${q.question.slice(0, 60)}`);
			for (let i = 0; i < (q.options?.length ?? 0); i++) {
				lines.push(`  ${qi + 1}.${i + 1} ${q.options![i].label}`);
			}
		}
		lines.push("⚠️ 多题暂不支持飞书应答，请回终端操作");
	}
	return lines.join("\n");
}

/** 发送文本的统一降级封装 */
async function safeSendText(
	deps: BroadcastDeps,
	chatId: string,
	text: string,
): Promise<boolean> {
	try {
		const res = await deps.client.im.message.create({
			data: {
				receive_id: chatId,
				content: JSON.stringify({ text }),
				msg_type: "text",
			},
			params: { receive_id_type: "chat_id" },
		} as never);
		const code = (res as unknown as { code?: number }).code;
		if (code !== 0 && code !== undefined) {
			deps.logger?.(`[pi-feishu] 群消息发送失败 code=${code}`);
			return false;
		}
		return true;
	} catch (err) {
		deps.logger?.(
			`[pi-feishu] 群消息发送异常: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
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
