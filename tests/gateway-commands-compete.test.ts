import { describe, expect, it, vi } from "vitest";

// ESM namespace 不可 spyOn，用模块 mock
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execSync: vi.fn() };
});

import { execSync } from "node:child_process";
import { findCompetingFeishuClients } from "../lib/gateway/commands";

const mockExec = vi.mocked(execSync);

describe("findCompetingFeishuClients — 同 app 竞争 WS 客户端扫描", () => {
	it("检测到 feishu 相关进程（排除网关本体）", () => {
		mockExec.mockReturnValue(
			(
				"node.exe,scripts/t1-verify.mjs listen --feishu,14600\n" +
				"node.exe,C:\\x\\pi-feishu\\bin\\pi-feishu-gateway.js,7348\n" +
				"node.exe,pi-feishu\\bin\\pi-feishu-gateway.js,999\n"
			) as unknown as Buffer,
		);
		const found = findCompetingFeishuClients(7348);
		expect(found).toHaveLength(1);
		expect(String(found[0]?.cmd)).toContain("t1-verify");
		expect(found[0]?.pid).toBe(14600);
	});

	it("无 feishu 相关进程 → 空", () => {
		mockExec.mockReturnValue(
			"node.exe,vite,1234\nnode.exe,pi main,5678\n" as unknown as Buffer,
		);
		expect(findCompetingFeishuClients()).toEqual([]);
	});

	it("execSync 失败 → 空数组不抛错", () => {
		mockExec.mockImplementation(() => {
			throw new Error("scan fail");
		});
		expect(findCompetingFeishuClients()).toEqual([]);
	});
});
