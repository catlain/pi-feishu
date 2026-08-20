import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	appendOutbox,
	consumeOutboxHead,
	drainAcked,
	listOutboxSessions,
	newEntryId,
	outboxPath,
	readAck,
	readOutboxAll,
	removeOutboxEntry,
	writeAck,
	ASK_WAITING_TTL_MS,
} from "../lib/outbox";
import type { OutboxEntry } from "../lib/types";

// 临时目录隔离（不污染真实 ~/.pi）
function mkDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "feishu-outbox-"));
}

function entry(partial: Partial<OutboxEntry> = {}): Omit<OutboxEntry, "id" | "createdAt"> {
	return { kind: "reply", text: "hello", expectAck: false, ...partial };
}

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function newDir(): string {
	const d = mkDir();
	dirs.push(d);
	return d;
}

describe("outbox 文件读写", () => {
	it("appendOutbox 创建文件并追加 FIFO", () => {
		const dir = newDir();
		const a = appendOutbox("s1", entry({ text: "first" }), dir);
		const b = appendOutbox("s1", entry({ text: "second" }), dir);
		expect(a.id).not.toBe(b.id);
		const all = readOutboxAll("s1", dir);
		expect(all.map((e) => e.text)).toEqual(["first", "second"]);
		expect(all[0]!.createdAt).toBeLessThanOrEqual(all[1]!.createdAt);
	});

	it("consumeOutboxHead 按序消费，空后删除文件", () => {
		const dir = newDir();
		appendOutbox("s1", entry({ text: "1" }), dir);
		appendOutbox("s1", entry({ text: "2" }), dir);
		expect(consumeOutboxHead("s1", dir)?.text).toBe("1");
		expect(consumeOutboxHead("s1", dir)?.text).toBe("2");
		expect(consumeOutboxHead("s1", dir)).toBeNull();
		expect(fs.existsSync(outboxPath("s1", dir))).toBe(false);
	});

	it("removeOutboxEntry 按 id 删除", () => {
		const dir = newDir();
		const a = appendOutbox("s1", entry(), dir);
		expect(removeOutboxEntry("s1", a.id, dir)).toBe(true);
		expect(removeOutboxEntry("s1", a.id, dir)).toBe(false);
		expect(readOutboxAll("s1", dir)).toHaveLength(0);
	});

	it("listOutboxSessions 列出 sessionId", () => {
		const dir = newDir();
		expect(listOutboxSessions(dir)).toEqual([]);
		appendOutbox("sa", entry(), dir);
		appendOutbox("sb", entry(), dir);
		expect(listOutboxSessions(dir).sort()).toEqual(["sa", "sb"]);
	});
});

describe("ack 回写", () => {
	it("writeAck 回写 result；readAck 读取；drainAcked 取走并移除", () => {
		const dir = newDir();
		const a = appendOutbox("s1", entry({ expectAck: true }), dir);
		const b = appendOutbox("s1", entry({ expectAck: true }), dir);
		expect(readAck("s1", a.id, dir)).toBeNull();
		expect(writeAck("s1", a.id, { sent: true, messageId: "m1" }, dir)).toBe(true);
		expect(writeAck("s1", "no-such", { sent: false }, dir)).toBe(false);
		expect(readAck("s1", a.id, dir)).toEqual({ sent: true, messageId: "m1" });
		// 未回执的 b 不被 drain
		const acked = drainAcked("s1", dir);
		expect(acked).toEqual([{ id: a.id, result: { sent: true, messageId: "m1" } }]);
		expect(readOutboxAll("s1", dir).map((e) => e.id)).toEqual([b.id]);
	});
});

describe("容错", () => {
	it("损坏文件视为空队列（不抛出），后续写入恢复", () => {
		const dir = newDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(outboxPath("s1", dir), "{broken json", "utf-8");
		expect(readOutboxAll("s1", dir)).toEqual([]);
		expect(consumeOutboxHead("s1", dir)).toBeNull();
		appendOutbox("s1", entry(), dir);
		expect(readOutboxAll("s1", dir)).toHaveLength(1);
	});

	it("非数组 JSON 视为空", () => {
		const dir = newDir();
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(outboxPath("s1", dir), '{"a":1}', "utf-8");
		expect(readOutboxAll("s1", dir)).toEqual([]);
	});

	it("目录不存在时各操作静默返回空", () => {
		const dir = path.join(newDir(), "nonexistent");
		expect(readOutboxAll("s1", dir)).toEqual([]);
		expect(listOutboxSessions(dir)).toEqual([]);
	});
});

describe("常量", () => {
	it("ask-waiting TTL 为 1 小时", () => {
		expect(ASK_WAITING_TTL_MS).toBe(60 * 60_000);
	});

	it("newEntryId 唯一", () => {
		expect(newEntryId()).not.toBe(newEntryId());
	});
});
