import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	drainAll,
	drainSession,
	isExpired,
	startOutboxDrainer,
	type DrainerDeps,
} from "../lib/gateway/outbox-drainer";
import {
	appendOutbox,
	readOutboxAll,
	appendOutbox as append,
} from "../lib/outbox";
import type { OutboxEntry } from "../lib/types";

const dirs: string[] = [];
function newDir(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-drainer-"));
	dirs.push(d);
	return d;
}
afterEach(() => {
	for (const d of dirs.splice(0)) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function mkDeps(
	sends: Array<{ text: string }>,
	opts?: { fail?: boolean; docUrl?: string },
): DrainerDeps {
	return {
		sendEntry: async (_e, text) => {
			sends.push({ text });
			if (opts?.fail) return { sent: false, error: "net down" };
			return { sent: true, messageId: `m${sends.length}` };
		},
		exportDoc: opts?.docUrl
			? async () => ({ ok: true, url: opts.docUrl })
			: async () => null,
		log: () => {},
	};
}

function entry(partial: Partial<OutboxEntry> = {}): OutboxEntry {
	return {
		id: `e${Math.random().toString(36).slice(2)}`,
		createdAt: Date.now(),
		kind: "reply",
		text: "t",
		expectAck: false,
		...partial,
	};
}

describe("isExpired", () => {
	it("ask-waiting 超 1h 过期；其他 kind 不过期", () => {
		const old = Date.now() - 61 * 60_000;
		expect(isExpired(entry({ kind: "ask-waiting", createdAt: old }))).toBe(true);
		expect(isExpired(entry({ kind: "reply", createdAt: old }))).toBe(false);
		expect(
			isExpired(entry({ kind: "ask-waiting", createdAt: Date.now() - 1000 })),
		).toBe(false);
	});
});

describe("drainSession 状态机", () => {
	it("fire-and-forget：发送后删除条目", async () => {
		const dir = newDir();
		appendOutbox("s1", entry({ text: "hello" }), dir);
		const sends: Array<{ text: string }> = [];
		await drainSession("s1", mkDeps(sends), dir);
		expect(sends).toEqual([{ text: "hello" }]);
		expect(readOutboxAll("s1", dir)).toHaveLength(0);
	});

	it("FIFO 保序", async () => {
		const dir = newDir();
		appendOutbox("s1", entry({ text: "1" }), dir);
		appendOutbox("s1", entry({ text: "2" }), dir);
		appendOutbox("s1", entry({ text: "3" }), dir);
		const sends: Array<{ text: string }> = [];
		await drainSession("s1", mkDeps(sends), dir);
		expect(sends.map((s) => s.text)).toEqual(["1", "2", "3"]);
	});

	it("expectAck：发送后回写 result（保留在文件中）", async () => {
		const dir = newDir();
		const e = appendOutbox("s1", entry({ text: "ack-me", expectAck: true }), dir);
		const sends: Array<{ text: string }> = [];
		await drainSession("s1", mkDeps(sends), dir);
		expect(sends).toHaveLength(1);
		const rest = readOutboxAll("s1", dir);
		expect(rest).toHaveLength(1);
		expect(rest[0]!.id).toBe(e.id);
		expect(rest[0]!.result).toMatchObject({ sent: true, messageId: "m1" });
	});

	it("发送失败：回写 result.error，不重试不抛出", async () => {
		const dir = newDir();
		const e = appendOutbox("s1", entry({ text: "x", expectAck: true }), dir);
		await drainSession("s1", mkDeps([], { fail: true }), dir);
		expect(readOutboxAll("s1", dir)[0]!.result).toMatchObject({
			sent: false,
			error: "net down",
		});
	});

	it("已回执条目跳过（不重复发送）", async () => {
		const dir = newDir();
		appendOutbox(
			"s1",
			entry({ text: "done", expectAck: true, result: { sent: true } }),
			dir,
		);
		const sends: Array<{ text: string }> = [];
		const n = await drainSession("s1", mkDeps(sends), dir);
		expect(n).toBe(0);
		expect(sends).toHaveLength(0);
	});

	it("过期 ask-waiting 条目丢弃", async () => {
		const dir = newDir();
		const stale = Date.now() - 2 * 60 * 60_000;
		appendOutbox(
			"s1",
			entry({ kind: "ask-waiting", text: "stale", createdAt: stale }),
			dir,
		);
		const sends: Array<{ text: string }> = [];
		await drainSession("s1", mkDeps(sends), dir);
		expect(sends).toHaveLength(0);
		expect(readOutboxAll("s1", dir)).toHaveLength(0);
	});

	it("doc-export：导出成功追加链接 + docUrl 进回执", async () => {
		const dir = newDir();
		appendOutbox(
			"s1",
			entry({
				kind: "doc-export",
				text: "summary",
				docTitle: "T",
				docText: "full",
				expectAck: true,
			}),
			dir,
		);
		const sends: Array<{ text: string }> = [];
		await drainSession("s1", mkDeps(sends, { docUrl: "https://feishu.cn/docx/d1" }), dir);
		expect(sends[0]!.text).toContain("📄 全文: https://feishu.cn/docx/d1");
		expect(readOutboxAll("s1", dir)[0]!.result?.docUrl).toBe(
			"https://feishu.cn/docx/d1",
		);
	});

	it("doc-export：无 doc 能力时不追加链接", async () => {
		const dir = newDir();
		appendOutbox("s1", entry({ kind: "doc-export", text: "s", docText: "f" }), dir);
		const sends: Array<{ text: string }> = [];
		await drainSession("s1", mkDeps(sends), dir);
		expect(sends[0]!.text).toBe("s");
	});
});

describe("drainAll / startOutboxDrainer", () => {
	it("drainAll 扫描所有会话文件", async () => {
		const dir = newDir();
		appendOutbox("sa", entry({ text: "a" }), dir);
		appendOutbox("sb", entry({ text: "b" }), dir);
		const sends: Array<{ text: string }> = [];
		const n = await drainAll(mkDeps(sends), dir);
		expect(n).toBe(2);
		expect(sends.map((s) => s.text).sort()).toEqual(["a", "b"]);
	});

	it("startOutboxDrainer 周期消费，stop 停止", async () => {
		const dir = newDir();
		append("s1", entry({ text: "x" }), dir);
		const sends: Array<{ text: string }> = [];
		const stop = startOutboxDrainer(mkDeps(sends), 10, dir);
		await new Promise((r) => setTimeout(r, 50));
		stop();
		const count = sends.length;
		await new Promise((r) => setTimeout(r, 40));
		expect(sends.length).toBe(count); // 停止后不再消费
		expect(count).toBeGreaterThanOrEqual(1);
	});
});
