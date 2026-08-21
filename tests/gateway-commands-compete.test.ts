import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseGatewayPids } from "../lib/gateway/commands";

// execSync mock（同步扫描路径不在本文件直接测，parseGatewayPids 纯函数测解析逻辑）
vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

describe("parseGatewayPids — off 命令全量网关进程识别", () => {
	const csv =
		'"ProcessId","CommandLine"\n' +
		'"24076","""C:\\Program Files\\nodejs\\node.exe"" bin/pi-feishu-gateway.js"\n' +
		'"29020","""C:\\Program Files\\nodejs\\node.exe"" C:\\Users\\x\\pi-feishu\\bin\\pi-feishu-gateway.js"\n' +
		'"14600","""node.exe"" scripts/t1-verify.mjs listen --feishu"\n' +
		'"1234","""node.exe"" vite"\n';

	it("识别全部网关进程（新旧路径都算，供 off 全杀）", () => {
		const pids = parseGatewayPids(csv, 9999);
		expect(pids).toEqual([24076, 29020]);
	});

	it("排除自身", () => {
		const pids = parseGatewayPids(csv, 24076);
		expect(pids).toEqual([29020]);
	});

	it("验证脚本/无关进程不算网关", () => {
		const pids = parseGatewayPids(csv, 9999);
		expect(pids).not.toContain(14600);
		expect(pids).not.toContain(1234);
	});

	it("无网关进程 → 空", () => {
		expect(parseGatewayPids('"1234","node vite"', 9999)).toEqual([]);
	});
});

// 注：findCompetingFeishuClients 竞争扫描已随 feishu-gateway-simplify 第二轮
// （on/off 极简化）删除——on 只拉起、off 全杀网关进程，不再区分竞争者。
