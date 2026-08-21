import { describe, expect, it, vi } from "vitest";

// 依赖容错：mock 工厂抛错（模拟包未安装，import reject），askUserApi() 应返回 null 不抛
vi.mock("@pi-atelier/rpiv-ask-user", () => {
	throw new Error("Cannot find module '@pi-atelier/rpiv-ask-user'");
});

describe("askUserApi 依赖容错", () => {
	it("import 失败（包未安装）→ null", async () => {
		const { askUserApi } = await import("../lib/ask-user-api");
		expect(await askUserApi()).toBeNull();
	});
});
