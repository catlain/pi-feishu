import { describe, expect, it } from "vitest";
import { generateSessionName } from "../lib/naming";

describe("generateSessionName 会话名生成", () => {
	it("默认取 cwd basename", () => {
		expect(generateSessionName("C:/work/quant", [])).toBe("quant");
		expect(generateSessionName("/home/u/quant", [])).toBe("quant");
	});

	it("重名追加 -2、-3 后缀", () => {
		expect(generateSessionName("/a/quant", ["quant"])).toBe("quant-2");
		expect(generateSessionName("/a/quant", ["quant", "quant-2"])).toBe("quant-3");
	});

	it("排除自己的条目（改名场景）", () => {
		// 调用方先 filter 掉自己，此处只验证 taken 列表语义
		expect(generateSessionName("/a/quant", ["other"])).toBe("quant");
	});

	it("空 basename 兜底 session", () => {
		expect(generateSessionName("", [])).toBe("session");
	});
});
