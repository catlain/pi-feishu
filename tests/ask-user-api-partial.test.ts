import { describe, expect, it, vi } from "vitest";

// 依赖容错：mock 工厂返回不完整导出（模拟旧版/异常包），askUserApi() 应返回 null 不抛
vi.mock("@pi-atelier/rpiv-ask-user", () => ({}));

describe("askUserApi 依赖容错", () => {
	it("导出不完整（无命名函数）→ null", async () => {
		const { askUserApi } = await import("../lib/ask-user-api");
		expect(await askUserApi()).toBeNull();
	});
});
