import { describe, expect, it } from "vitest";
import { generateSessionName } from "../lib/naming";

describe("会话名生成", () => {
	it("默认取 cwd basename", () => {
		expect(generateSessionName("D:/Project/Quant/quant-strategy", [])).toBe(
			"quant-strategy",
		);
	});

	it("重名追加数字后缀", () => {
		expect(generateSessionName("/x/pi-atelier", ["pi-atelier"])).toBe("pi-atelier-2");
		expect(generateSessionName("/x/pi-atelier", ["pi-atelier", "pi-atelier-2"])).toBe(
			"pi-atelier-3",
		);
	});

	it("无冲突不加后缀", () => {
		expect(generateSessionName("/x/foo", ["bar"])).toBe("foo");
	});

	it("空 cwd 兜底 session", () => {
		expect(generateSessionName("", [])).toBe("session");
	});
});
