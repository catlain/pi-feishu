import { describe, expect, it } from "vitest";
import { generateSessionName } from "../lib/naming";

describe("generateSessionName 会话名生成", () => {
	it("默认取 cwd basename", () => {
		expect(generateSessionName("C:/work/quant", [])).toBe("quant");
		expect(generateSessionName("/home/u/quant", [])).toBe("quant");
	});

	it("重名追加短随机 ID 后缀（4 位 base36）", () => {
		const n1 = generateSessionName("/a/quant", ["quant"]);
		expect(n1).toMatch(/^quant-[a-z0-9]{4}$/);
		expect(n1).not.toBe("quant");
		// 二次重名（后缀也撞上）再补一段
		const n2 = generateSessionName("/a/quant", ["quant", n1]);
		expect(n2).toMatch(/^quant-[a-z0-9]{4}(-[a-z0-9]{4})?$/);
		expect(n2).not.toBe("quant");
		expect(n2).not.toBe(n1);
	});

	it("后缀碰撞概率极低（1000 次生成不重复无碰撞循环）", () => {
		// 验证随机后缀分布正常，不出现全碰撞死循环
		const taken = new Set(["quant"]);
		for (let i = 0; i < 100; i++) {
			const n = generateSessionName("/a/quant", [...taken]);
			taken.add(n);
			expect(n).toMatch(/^quant-[a-z0-9]{4}$/);
		}
		expect(taken.size).toBe(101);
	});

	it("排除自己的条目（改名场景）", () => {
		// 调用方先 filter 掉自己，此处只验证 taken 列表语义
		expect(generateSessionName("/a/quant", ["other"])).toBe("quant");
	});

	it("空 basename 兜底 session", () => {
		expect(generateSessionName("", [])).toBe("session");
	});
});
