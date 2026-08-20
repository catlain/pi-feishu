import { describe, expect, it } from "vitest";
import { generateSessionName } from "../lib/naming";

describe("generateSessionName 会话名生成", () => {
	it("默认取 cwd basename（带后缀）", () => {
		expect(generateSessionName("C:/work/quant", [])).toMatch(/^quant-[a-z0-9]{4}$/);
		expect(generateSessionName("/home/u/quant", [])).toMatch(/^quant-[a-z0-9]{4}$/);
	});

	it("全部带短随机 ID 后缀（4 位 base36）", () => {
		const n1 = generateSessionName("/a/quant", []);
		expect(n1).toMatch(/^quant-[a-z0-9]{4}$/);
		// 占用时再补一段，不重不回退裸名
		const n2 = generateSessionName("/a/quant", [n1]);
		expect(n2).toMatch(/^quant-[a-z0-9]{4}(-[a-z0-9]{4})?$/);
		expect(n2).not.toBe(n1);
	});

	it("随机分布正常（100 次生成不碰撞死循环）", () => {
		const taken = new Set<string>();
		for (let i = 0; i < 100; i++) {
			const n = generateSessionName("/a/quant", [...taken]);
			taken.add(n);
			expect(n).toMatch(/^quant-[a-z0-9]{4}$/);
		}
		expect(taken.size).toBe(100);
	});

	it("无冲突时也不与他人重名", () => {
		expect(generateSessionName("/a/quant", ["other"])).toMatch(/^quant-[a-z0-9]{4}$/);
	});

	it("空 basename 兜底 session（带后缀）", () => {
		expect(generateSessionName("", [])).toMatch(/^session-[a-z0-9]{4}$/);
	});
});
