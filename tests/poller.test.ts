/**
 * feishu-poll-primary 单测（T4.1）— 水位推进/回退、索引滞后重叠、合并分组、
 * 去重、bot 自消息过滤、适配器、注入、间隔校验。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	filterByWatermark,
	readWatermark,
	writeWatermark,
	watermarkPath,
	groupForMerge,
	mergeTexts,
	MessageIdDedup,
} from "../lib/gateway/poller-core";
import { parsePolledMessage, type PolledMessageItem } from "../lib/events";
import { injectPolledItems } from "../lib/gateway/poller-inject";
import {
	validateIntervalSec,
	FEISHU_POLL_INTERVAL_DEFAULT,
} from "../lib/gateway/interval-config";

function item(over: Partial<PolledMessageItem> = {}): PolledMessageItem {
	return {
		message_id: `om-${Math.random().toString(36).slice(2, 8)}`,
		chat_id: "oc-test",
		create_time: "1700000000000",
		message_position: "100",
		sender: { id: "ou-user", id_type: "open_id", sender_type: "user" },
		body: { content: JSON.stringify({ text: "@_user_1 hi" }) },
		mentions: [{ key: "@_user_1", id: "ou-bot", id_type: "open_id" }],
		...over,
	};
}

// ── 水位过滤（D2）────────────────────────────────────────

describe("filterByWatermark", () => {
	it("无水位（首启/损坏回退）：全部通过（时间窗已限定范围）", () => {
		const { items, newWatermark } = filterByWatermark([item(), item()], null);
		expect(items).toHaveLength(2);
		expect(newWatermark).not.toBeNull();
	});

	it("position > 水位 过滤；水位推进到最大 position", () => {
		const prev = { position: 100, createTimeMs: 1_700_000_000_000, updatedAt: 0 };
		const { items, newWatermark } = filterByWatermark(
			[item({ message_position: "99" }), item({ message_position: "100" }), item({ message_position: "101" })],
			prev,
		);
		expect(items.map((i) => i.message_position)).toEqual(["101"]);
		expect(newWatermark?.position).toBe(101);
	});

	it("索引滞后：新消息未返回时水位不推进，下一轮重叠窗重拉补达", () => {
		const prev = { position: 100, createTimeMs: 1_700_000_000_000, updatedAt: 0 };
		// 本轮 API 只返回旧消息（最新因索引滞后未出现）
		const { items, newWatermark } = filterByWatermark([item({ message_position: "99" })], prev);
		expect(items).toHaveLength(0);
		expect(newWatermark).toBeNull(); // 水位不越过未消费消息
		// 下一轮重叠窗口返回 99~101：99 被水位过滤，101 通过
		const again = filterByWatermark(
			[item({ message_position: "99" }), item({ message_position: "101" })],
			prev, // 水位未推进
		);
		expect(again.items.map((i) => i.message_position)).toEqual(["101"]);
	});

	it("position 缺失时按 create_time 兜底过滤", () => {
		const prev = { position: 100, createTimeMs: 1_700_000_000_000, updatedAt: 0 };
		const older = item({ message_position: undefined, create_time: "1699999999000" });
		const newer = item({ message_position: undefined, create_time: "1700000001000" });
		const { items } = filterByWatermark([older, newer], prev);
		expect(items).toEqual([newer]);
	});

	it("deleted 消息过滤", () => {
		const { items } = filterByWatermark([item({ deleted: true }), item({ deleted: false })], null);
		expect(items).toHaveLength(1);
	});

	it("结果按 position 升序（API 乱序返回时）", () => {
		const { items } = filterByWatermark(
			[item({ message_position: "103" }), item({ message_position: "101" }), item({ message_position: "102" })],
			null,
		);
		expect(items.map((i) => i.message_position)).toEqual(["101", "102", "103"]);
	});
});

// ── 水位持久化（D2）──────────────────────────────────────

describe("watermark persistence", () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "poller-wm-"));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("写入后可读回；损坏/缺失返回 null（回退时间窗）", () => {
		const file = watermarkPath(dir);
		expect(readWatermark(file)).toBeNull();
		writeWatermark(file, { position: 42, createTimeMs: 1, updatedAt: 2 });
		expect(readWatermark(file)?.position).toBe(42);
		fs.writeFileSync(file, "{corrupted");
		expect(readWatermark(file)).toBeNull();
	});
});

// ── 同窗合并（D3）────────────────────────────────────────

describe("groupForMerge / mergeTexts", () => {
	it("命令独立、转交按目标分组", () => {
		const mk = (kind: "command" | "ignored" | "transfer", target = "s1", text = "hi") => ({
			parsed: { ...parsePolledMessage(item(), "ou-bot"), text },
			decision:
				kind === "transfer"
					? { kind, targetSessionId: target, targetSessionName: target }
					: kind === "command"
						? { kind, reason: "list" as const }
						: { kind },
		});
		const { commands, merged } = groupForMerge([
			mk("command"),
			mk("transfer", "s1", "a"),
			mk("transfer", "s1", "b"),
			mk("transfer", "s2", "c"),
			mk("ignored"),
		]);
		expect(commands).toHaveLength(1);
		expect(merged.map((g) => [g.targetSessionId, g.entries.length])).toEqual([
			["s1", 2],
			["s2", 1],
		]);
	});

	it("单条不加标注；多条换行拼接 + 条数标注", () => {
		expect(mergeTexts(["hello"])).toBe("hello");
		expect(mergeTexts(["a", "b", "c"])).toBe("[3 条合并]\na\nb\nc");
	});
});

// ── 双键去重（D5）────────────────────────────────────────

describe("MessageIdDedup", () => {
	it("has/add 语义 + 滚动环形淘汰", () => {
		const d = new MessageIdDedup(3);
		for (const id of ["a", "b", "c"]) d.add(id);
		expect(d.has("a")).toBe(true);
		d.add("d");
		expect(d.has("a")).toBe(false); // 容量 3 淘汰 a
		expect(d.has("d")).toBe(true);
	});
});

// ── 适配器（T1.2）────────────────────────────────────────

describe("parsePolledMessage", () => {
	it("sender/mentions/parent_id/content 解析，@占位符剥除", () => {
		const p = parsePolledMessage(
			item({ parent_id: "om-parent", body: { content: JSON.stringify({ text: "@_user_1 继续改" }) } }),
			"ou-bot",
		);
		expect(p.senderOpenId).toBe("ou-user");
		expect(p.mentionedBot).toBe(true);
		expect(p.parentId).toBe("om-parent");
		expect(p.text).toBe("继续改");
		expect(p.position).toBe(100);
		expect(p.isSelfMessage).toBe(false);
	});

	it("bot 自消息（sender_type=app）标记", () => {
		const p = parsePolledMessage(
			item({ sender: { id: "ou-bot", id_type: "open_id", sender_type: "app" } }),
			"ou-bot",
		);
		expect(p.isSelfMessage).toBe(true);
	});
});

// ── 注入（T1.3）──────────────────────────────────────────

describe("injectPolledItems", () => {
	function deps() {
		const written: { sessionId: string; data: { command: string; kind?: string } }[] = [];
		const replies: string[] = [];
		return {
			base: {
				claims: [{ sessionId: "s1", sessionName: "work", chatId: "oc-test", claimedAt: Date.now(), heartbeat: Date.now() }],
				whitelist: ["ou-user"],
				writePending: (sessionId: string, data: { command: string; kind?: string }) =>
					void written.push({ sessionId, data }),
				reply: (text: string) => void replies.push(text),
				botOpenId: "ou-bot",
				chatId: "oc-test",
				dedup: new MessageIdDedup(),
				log: () => {},
			},
			written,
			replies,
		};
	}

	it("同窗多条同目标合并为一条注入 + 条数回执", () => {
		const d = deps();
		injectPolledItems(
			[
				item({ body: { content: JSON.stringify({ text: "@_user_1 work a" }) } }),
				item({ body: { content: JSON.stringify({ text: "@_user_1 work b" }) } }),
			],
			d.base,
		);
		expect(d.written).toHaveLength(1);
		expect(d.written[0].data.command).toContain("[2 条合并]");
		expect(d.replies[0]).toContain("合并 2 条");
	});

	it("WS 已处理过的 message_id 跳过（双通道幂等）", () => {
		const d = deps();
		const shared = item({ body: { content: JSON.stringify({ text: "@_user_1 work a" }) } });
		d.base.dedup.add(shared.message_id);
		injectPolledItems([shared], d.base);
		expect(d.written).toHaveLength(0);
	});

	it("bot 自消息过滤；命令类逐条独立", () => {
		const d = deps();
		injectPolledItems(
			[
				item({ sender: { id: "ou-bot", id_type: "open_id", sender_type: "app" } }),
				item({ body: { content: JSON.stringify({ text: "@_user_1 list" }) } }),
			],
			d.base,
		);
		expect(d.written).toHaveLength(0);
		expect(d.replies.some((r) => r.includes("work") || r.includes("list"))).toBe(true);
	});
});

// ── 间隔校验（D4）────────────────────────────────────────

describe("validateIntervalSec", () => {
	it("10~600 边界", () => {
		expect(validateIntervalSec(9)).not.toBeNull();
		expect(validateIntervalSec(10)).toBeNull();
		expect(validateIntervalSec(600)).toBeNull();
		expect(validateIntervalSec(601)).not.toBeNull();
		expect(validateIntervalSec(NaN)).not.toBeNull();
		expect(FEISHU_POLL_INTERVAL_DEFAULT).toBe(60);
	});
});
