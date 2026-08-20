/**
 * outbox-drainer — 网关出站发送器
 * 轮询 outbox/<sessionId>.json → 按序 REST 发送 → fire-and-forget 条目删除、
 * expectAck 条目回写 result。发送失败回写 result.error，不无限重试
 * （与 broadcast 原有静默降级语义一致）。
 * 网关重启重放：条目持久化在文件里，drainer 启动即自然重放；
 * ask-waiting 类条目超过 TTL（>1h）视为过期丢弃。
 *
 * sendEntry 是网关侧统一发送入口（后续 topic-binding 复用，
 * 支持 reply / 未来 reply_in_thread 扩展）。
 */

import {
	ASK_WAITING_TTL_MS,
	OUTBOX_DIR,
	listOutboxSessions,
	readOutboxAll,
	removeOutboxEntry,
	writeAck,
} from "../outbox";
import type { OutboxEntry, OutboxResult } from "../types";
import { recordAnchor } from "./anchors";

export interface DrainerDeps {
	/** 统一发送入口：文本 → 飞书 REST（失败不抛出，返回 error） */
	sendEntry: (entry: OutboxEntry, text: string) => Promise<{ sent: boolean; messageId?: string; error?: string }>;
	/** 文档导出（无 docx 能力时返回 null） */
	exportDoc: (title: string, text: string) => Promise<{ ok: boolean; url?: string; error?: string } | null>;
	/** 发送成功后记录锚点（messageId → sessionId）；缺省不记（测试/旧调用兼容） */
	recordAnchor?: (messageId: string, sessionId: string) => void;
	/** 任一发送成功回调（帧水位判活出站侧接线） */
	onSent?: () => void;
	log: (msg: string) => void;
}

/** 条目是否过期（应丢弃） */
export function isExpired(entry: OutboxEntry, now: number = Date.now()): boolean {
	return entry.kind === "ask-waiting" && now - entry.createdAt > ASK_WAITING_TTL_MS;
}

/** 处理单个 outbox 文件（某会话的整条队列，按 FIFO 顺序发送） */
export async function drainSession(
	sessionId: string,
	deps: DrainerDeps,
	dir?: string,
	now: number = Date.now(),
): Promise<number> {
	let entries: OutboxEntry[];
	entries = readOutboxAll(sessionId, dir ?? OUTBOX_DIR);
	let sent = 0;
	for (const entry of entries) {
		if (isExpired(entry, now)) {
			deps.log(`[outbox] ${sessionId} 过期丢弃 kind=${entry.kind} id=${entry.id}`);
			removeOutboxEntry(sessionId, entry.id, dir);
			continue;
		}
		if (entry.result !== undefined) {
			continue; // 已回执，等会话取走
		}
		const result = await sendEntry(entry, deps);
		sent++;
		// 发送成功即锚点（D1）：expectAck 与 fire-and-forget 条目都记
		if (result.sent && result.messageId && deps.recordAnchor) {
			deps.recordAnchor(result.messageId, sessionId);
		}
		if (result.sent) deps.onSent?.();
		if (entry.expectAck) {
			writeAck(sessionId, entry.id, result, dir);
		} else {
			removeOutboxEntry(sessionId, entry.id, dir);
		}
	}
	return sent;
}

/** 组装并发送单个条目：doc-export 类先导出文档再追加链接 */
async function sendEntry(
	entry: OutboxEntry,
	deps: DrainerDeps,
): Promise<OutboxResult> {
	let text = entry.text;
	let docUrl: string | undefined;
	if (entry.kind === "doc-export") {
		const exported = await deps.exportDoc(entry.docTitle ?? "[pi] 未命名文档", entry.docText ?? entry.text);
		if (exported?.ok && exported.url) {
			docUrl = exported.url;
			text = `${text}\n📄 全文: ${docUrl}`;
		} else if (exported) {
			text = `${text}\n⚠️ 文档导出失败（${exported.error}）`;
		}
	}
	const r = await deps.sendEntry(entry, text);
	return {
		sent: r.sent,
		...(r.messageId ? { messageId: r.messageId } : {}),
		...(docUrl ? { docUrl } : {}),
		...(r.error ? { error: r.error } : {}),
	};
}

/** 扫描一轮全部 outbox 文件 */
export async function drainAll(
	deps: DrainerDeps,
	dir?: string,
	now: number = Date.now(),
): Promise<number> {
	let total = 0;
	for (const sessionId of listOutboxSessions(dir)) {
		try {
			total += await drainSession(sessionId, deps, dir, now);
		} catch (err) {
			deps.log(`[outbox] ${sessionId} 处理异常: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return total;
}

/** 启动轮询（网关进程用；返回停止函数） */
export function startOutboxDrainer(
	deps: DrainerDeps,
	intervalMs = 2000,
	dir?: string,
): () => void {
	const timer = setInterval(() => {
		void drainAll(deps, dir).catch(() => {});
	}, intervalMs);
	// Node setInterval 不保持进程存活（网关有 WS 连接在保活）
	if (typeof timer === "object" && "unref" in timer) timer.unref();
	return () => clearInterval(timer);
}

/** 飞书 Client 的最小结构（避免拉入完整 lark Client 类型） */
interface GatewayClientLike {
	im: { message: { create: (args: unknown) => Promise<unknown> } };
}

/** 网关出站启动封装：client + chatId → drainer（含统一发送入口与文档导出） */
export function startGatewayOutbox(
	client: GatewayClientLike,
	chatId: string,
	deps: {
		exportDoc: (title: string, text: string) => Promise<{ ok: boolean; url?: string; error?: string } | null>;
		/** 任一发送成功回调（帧水位判活出站侧接线） */
		onSent?: () => void;
		log: (msg: string) => void;
	},
	intervalMs = 2000,
): () => void {
	return startOutboxDrainer(
		{
			sendEntry: async (_entry, text) => {
				try {
					const res = (await client.im.message.create({
						data: {
							receive_id: chatId,
							content: JSON.stringify({ text }),
							msg_type: "text",
						},
						params: { receive_id_type: "chat_id" },
					})) as unknown as { code?: number; data?: { message_id?: string } };
					if (res.code !== 0 && res.code !== undefined) {
						return { sent: false, error: `code=${res.code}` };
					}
					return { sent: true, messageId: res.data?.message_id };
				} catch (err) {
					return { sent: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
			exportDoc: deps.exportDoc,
			// 每条出站即锚点（feishu-reply-binding D1）：messageId → sessionId
			recordAnchor,
			onSent: deps.onSent,
			log: deps.log,
		},
		intervalMs,
	);
}
