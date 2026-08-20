/**
 * outbox 出站队列 — 会话 → 网关的上送通道（pending.ts 的对偶）
 * 目录：~/.pi/agent/feishu-bridge/outbox/<sessionId>.json（FIFO 数组）
 * 普通条目：网关消费（读取即删）；expectAck 条目：网关回写 result，
 * 会话轮询读到 result 后删除。原子写 tmp+rename。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CLAIM_DIR } from "./claim";
import type { OutboxEntry, OutboxResult } from "./types";

export const OUTBOX_DIR = path.join(CLAIM_DIR, "outbox");
/** ask-waiting 类条目重放过期时间（网关重启重放时判用） */
export const ASK_WAITING_TTL_MS = 60 * 60_000;

export function outboxPath(sessionId: string, dir = OUTBOX_DIR): string {
	return path.join(dir, `${sessionId}.json`);
}

function readOutbox(sessionId: string, dir: string): OutboxEntry[] {
	const p = outboxPath(sessionId, dir);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf-8");
	} catch {
		return []; // 不存在
	}
	try {
		const data = JSON.parse(raw) as unknown;
		return Array.isArray(data) ? (data as OutboxEntry[]) : [];
	} catch {
		return []; // 损坏文件视为空
	}
}

function writeOutbox(sessionId: string, entries: OutboxEntry[], dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
	const p = outboxPath(sessionId, dir);
	const tmp = `${p}.tmp`;
	if (entries.length === 0) {
		// 空队列直接删文件
		try {
			fs.unlinkSync(p);
		} catch {
			// 不存在即无事
		}
		return;
	}
	fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + "\n", "utf-8");
	fs.renameSync(tmp, p);
}

/** 生成新条目 id */
export function newEntryId(): string {
	return randomUUID();
}

/** 会话侧追加出站条目（FIFO 追加到队尾） */
export function appendOutbox(
	sessionId: string,
	entry: Omit<OutboxEntry, "id" | "createdAt"> & { id?: string; createdAt?: number },
	dir = OUTBOX_DIR,
): OutboxEntry {
	if (!sessionId) throw new Error("appendOutbox: sessionId 为空（测试泄漏防护）");
	const full: OutboxEntry = {
		id: entry.id ?? newEntryId(),
		createdAt: entry.createdAt ?? Date.now(),
		kind: entry.kind,
		text: entry.text,
		expectAck: entry.expectAck,
		...(entry.docTitle !== undefined ? { docTitle: entry.docTitle } : {}),
		...(entry.docText !== undefined ? { docText: entry.docText } : {}),
		...(entry.result !== undefined ? { result: entry.result } : {}),
	};
	const entries = readOutbox(sessionId, dir);
	entries.push(full);
	writeOutbox(sessionId, entries, dir);
	return full;
}

/** 网关侧消费：读取并移除队首条目（FIFO；expectAck 条目由网关回写 result 而非消费删除）。
 * 指定 entryId 时只取该条（乱序防护下网关按序消费，一般不指定）。 */
export function consumeOutboxHead(
	sessionId: string,
	dir = OUTBOX_DIR,
): OutboxEntry | null {
	const entries = readOutbox(sessionId, dir);
	if (entries.length === 0) return null;
	writeOutbox(sessionId, entries.slice(1), dir);
	return entries[0]!;
}

/** 列出全部条目（网关 drainer 用，不做删除） */
export function readOutboxAll(sessionId: string, dir = OUTBOX_DIR): OutboxEntry[] {
	return readOutbox(sessionId, dir);
}

/** 移除指定条目（按 id），返回是否移除 */
export function removeOutboxEntry(sessionId: string, id: string, dir = OUTBOX_DIR): boolean {
	const entries = readOutbox(sessionId, dir);
	const idx = entries.findIndex((e) => e.id === id);
	if (idx < 0) return false;
	entries.splice(idx, 1);
	writeOutbox(sessionId, entries, dir);
	return true;
}

/** 网关回写回执（expectAck 条目发送后调用） */
export function writeAck(
	sessionId: string,
	id: string,
	result: OutboxResult,
	dir = OUTBOX_DIR,
): boolean {
	const entries = readOutbox(sessionId, dir);
	const idx = entries.findIndex((e) => e.id === id);
	if (idx < 0) return false;
	entries[idx] = { ...entries[idx]!, result };
	writeOutbox(sessionId, entries, dir);
	return true;
}

/** 会话侧读取回执：返回已带 result 的条目（调用方处理后自行 removeOutboxEntry） */
export function readAck(
	sessionId: string,
	id: string,
	dir = OUTBOX_DIR,
): OutboxResult | null {
	const entries = readOutbox(sessionId, dir);
	return entries.find((e) => e.id === id)?.result ?? null;
}

/** 会话侧取走全部已回执条目（id → result），并从队列移除 */
export function drainAcked(sessionId: string, dir = OUTBOX_DIR): Array<{ id: string; result: OutboxResult }> {
	const entries = readOutbox(sessionId, dir);
	const acked = entries.filter((e) => e.result !== undefined);
	if (acked.length === 0) return [];
	writeOutbox(
		sessionId,
		entries.filter((e) => e.result === undefined),
		dir,
	);
	return acked.map((e) => ({ id: e.id, result: e.result! }));
}

/** 列出 outbox 目录下所有 sessionId（网关 drainer 扫描用） */
export function listOutboxSessions(dir = OUTBOX_DIR): string[] {
	try {
		return fs
			.readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => f.slice(0, -".json".length));
	} catch {
		return [];
	}
}
