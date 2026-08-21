import { describe, expect, it, vi } from "vitest";

// ESM namespace 不可 spyOn，用模块 mock
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, execSync: vi.fn(), exec: vi.fn() };
});

import { execSync, exec } from "node:child_process";
import {
	findCompetingFeishuClients,
	findCompetingFeishuClientsAsync,
} from "../lib/gateway/commands";

type Rivals = Array<{ pid: number; cmd: string }>;

const mockExecSync = vi.mocked(execSync);
const mockExec = vi.mocked(exec);

/** 设定 exec mock 的响应（exec 多重重载无法精确匹配 vitest 推导签名，整体断言绕过） */
function stubExec(result: { err?: Error; stdout: string }): void {
	mockExec.mockImplementation(
		((...args: unknown[]) => {
			let cb: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
			for (let i = args.length - 1; i >= 0; i--) {
				if (typeof args[i] === "function") {
					cb = args[i] as typeof cb;
					break;
				}
			}
			cb?.(result.err ?? null, result.stdout, "");
		}) as never,
	);
}

describe("findCompetingFeishuClients — 同 app 竞争 WS 客户端扫描", () => {
	it("检测到 feishu 相关进程（排除网关本体）", () => {
		mockExecSync.mockReturnValue(Buffer.from(
			"node.exe,scripts/t1-verify.mjs listen --feishu,14600\n" +
				"node.exe,C:\\x\\pi-feishu\\bin\\pi-feishu-gateway.js,7348\n" +
				"node.exe,pi-feishu\\bin\\pi-feishu-gateway.js,999\n",
		));
		const found = findCompetingFeishuClients(7348);
		expect(found).toHaveLength(1);
		expect(String(found[0]?.cmd)).toContain("t1-verify");
		expect(found[0]?.pid).toBe(14600);
		// D1 弹窗治理：子进程不建新控制台
		expect(mockExecSync).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ windowsHide: true }),
		);
	});

	it("无 feishu 相关进程 → 空", () => {
		mockExecSync.mockReturnValue(
			Buffer.from("node.exe,vite,1234\nnode.exe,pi main,5678\n"),
		);
		expect(findCompetingFeishuClients()).toEqual([]);
	});

	it("execSync 失败 → 空数组不抛错", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("scan fail");
		});
		expect(findCompetingFeishuClients()).toEqual([]);
	});
});

	describe("findCompetingFeishuClientsAsync — 异步扫描（网关 30s 循环专用）", () => {
	it("结果经回调交付（排除网关本体）且子进程 windowsHide", async () => {
		stubExec({
			stdout:
				"node.exe,scripts/t1-verify.mjs listen --feishu,14600\n" +
					"node.exe,C:\\x\\pi-feishu\\bin\\pi-feishu-gateway.js,7348\n",
		});
		const got = await new Promise<Rivals>((resolve) => findCompetingFeishuClientsAsync(resolve, 7348));
		expect(got).toHaveLength(1);
		expect(got[0]?.pid).toBe(14600);
		expect(mockExec).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({ windowsHide: true }),
			expect.any(Function),
		);
	});

	it("无竞争 → 回调空数组", async () => {
		stubExec({ stdout: "node.exe,vite,1234\n" });
		const got = await new Promise<Rivals>((resolve) => findCompetingFeishuClientsAsync(resolve));
		expect(got).toEqual([]);
	});

	it("exec 失败/超时（err 或 killed）→ 回调空数组不抛错", async () => {
		stubExec({ err: new Error("Command failed: ... killed"), stdout: "" });
		const got = await new Promise<Rivals>((resolve) => findCompetingFeishuClientsAsync(resolve));
		expect(got).toEqual([]);
	});
});
