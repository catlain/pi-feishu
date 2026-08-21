import { describe, expect, it, vi } from "vitest";
import {
	broadcastAskWaiting,
	broadcastReply,
	buildAskWaitingBody,
	summarizeQuestions,
} from "../lib/broadcast";
import type { FeishuConfig } from "../lib/types";
import type { OutboxEntry } from "../lib/types";

const config: FeishuConfig = {
	chatId: "c1",
	whitelist: [],
};

/** mock outbox：收集追加的条目 */
function mkDeps() {
	const entries: OutboxEntry[] = [];
	const append = vi.fn((sessionId: string, e: Omit<OutboxEntry, "id" | "createdAt">) => {
		entries.push({ id: `id${entries.length}`, createdAt: Date.now(), ...e });
	});
	return {
		entries,
		deps: {
			config,
			sessionId: "s1",
			append: append as never,
		},
	};
}

describe("播报（outbox 出站）", () => {
	it("阈值内写 reply 条目（带会话名前缀，fire-and-forget）", () => {
		const { deps, entries } = mkDeps();
		const r = broadcastReply(deps, "quant", "短回复");
		expect(r.sent).toBe(true);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.kind).toBe("reply");
		expect(entries[0]!.expectAck).toBe(false);
		expect(entries[0]!.text).toContain("[pi:quant]");
		expect(entries[0]!.text).toContain("短回复");
	});

	it("超长回复不再截断导出，整条直发 reply 条目", () => {
		const long = "x".repeat(2500);
		const { deps, entries } = mkDeps();
		const r = broadcastReply(deps, "quant", long);
		expect(r.sent).toBe(true);
		expect(entries).toHaveLength(1);
		expect(entries[0]!.kind).toBe("reply");
		expect(entries[0]!.text).toBe(`[pi:quant]\n${long}`);
	});

	it("ask-user 等待提醒写 ask-waiting 条目含摘要", () => {
		const { deps, entries } = mkDeps();
		broadcastAskWaiting(deps, "quant", "选哪个？");
		expect(entries).toHaveLength(1);
		expect(entries[0]!.kind).toBe("ask-waiting");
		expect(entries[0]!.text).toContain("⏸ 等待输入");
		expect(entries[0]!.text).toContain("选哪个？");
	});

	it("summarizeQuestions 取首个问题", () => {
		expect(summarizeQuestions([{ question: "用哪个方案？", header: "方案" }])).toBe(
			"[方案] 用哪个方案？",
		);
	});

	describe("buildAskWaitingBody", () => {
		const singleQ = [
			{
				question: "用哪个方案？",
				header: "方案",
				options: [
					{ label: "A", description: "快" },
					{ label: "B" },
				],
			},
		];

		it("单题附编号选项和 answer 提示", () => {
			const body = buildAskWaitingBody("catlain", singleQ);
			expect(body).toContain("[方案] 用哪个方案？");
			expect(body).toContain("1. A — 快");
			expect(body).toContain("2. B");
			expect(body).toContain("回复 @bot catlain awr <编号> 选择");
		});

		it("多题播报：题型标注 + 选项 N.M + 示例行（不再提示回终端）", () => {
			const body = buildAskWaitingBody("catlain", [
				...singleQ,
				{ question: "确认吗？", options: [{ label: "是" }] },
			]);
			expect(body).toContain("1. [单选] 用哪个方案？");
			expect(body).toContain("2. [单选] 确认吗？");
			expect(body).toContain("2.1 是");
			expect(body).toContain("awr 1,1");
			expect(body).toContain("按题序逗号分隔，多选|，自定义=开头");
			expect(body).not.toContain("多题暂不支持");
		});

		it("多题播报快照：单选+多选混合含多选标注与|示例", () => {
			const body = buildAskWaitingBody("catlain", [
				{ question: "用哪个库？", options: [{ label: "A" }, { label: "B" }] },
				{ question: "启用哪些？", multiSelect: true, options: [{ label: "x" }, { label: "y" }, { label: "z" }] },
			]);
			expect(body).toBe(
				[
					"用哪个库？",
					"1. [单选] 用哪个库？",
					"  1.1 A  1.2 B",
					"2. [多选] 启用哪些？",
					"  2.1 x  2.2 y  2.3 z",
					"回复 @bot catlain awr 1,1|2（按题序逗号分隔，多选|，自定义=开头）",
				].join("\n"),
			);
		});

		it("无选项时回退摘要", () => {
			expect(buildAskWaitingBody("catlain", [{ question: "Q?" }])).toBe("Q?");
			expect(buildAskWaitingBody("catlain", [])).toBe("AI 正在等待你的选择");
		});
	});
});
