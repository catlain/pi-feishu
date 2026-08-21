/**
 * 网关生命周期命令 — /feishu-gateway on|off|status 的实现（极简版）
 *
 * on：只负责拉起网关进程（不管竞态、不管单例锁——off 会全量清理）。
 * off：扫描并杀掉所有飞书网关进程（含历史残留的多实例）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import type { ClaimEntry } from "../types";
import { isAlive, GATEWAY_LOG_PATH } from "../claim";
import { readLock, isLockValid } from "./lifecycle";

/** 命令 ctx 的最小结构 */
export type GatewayCommandCtx = {
	ui: { notify: (msg: string, type?: "info" | "error" | "warning") => void };
};

/** 扫描命令（win32: PowerShell CIM CSV / 其他: ps） */
function scanCommand(): { cmd: string; timeoutMs: number } {
	if (process.platform === "win32") {
		return {
			cmd: "powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation\"",
			timeoutMs: 15_000,
		};
	}
	return { cmd: "ps -eo pid,args", timeoutMs: 8_000 };
}

/** 解析扫描输出 → 全部网关进程 PID（排除自身；不区分新旧，off 全杀） */
export function parseGatewayPids(
	out: string,
	selfPid: number = process.pid,
): number[] {
	const pids: number[] = [];
	for (const line of out.split("\n")) {
		if (!/pi-feishu-gateway(\.js)?/.test(line)) continue;
		const pid = /^"(\d+)"/.exec(line.trim())?.[1];
		if (!pid || Number(pid) === selfPid) continue;
		pids.push(Number(pid));
	}
	return pids;
}

/** 同步扫描全部网关进程 PID（off 命令专用；扫描失败返回空） */
function findGatewayPids(): number[] {
	const { cmd, timeoutMs } = scanCommand();
	try {
		const out = childProcess
			.execSync(cmd, { encoding: "utf-8", timeout: timeoutMs, windowsHide: true })
			.toString();
		return parseGatewayPids(out);
	} catch {
		return [];
	}
}

export function gatewayOn(
	ctx: GatewayCommandCtx,
	hasCredentials: boolean,
): void {
	if (!hasCredentials) {
		ctx.ui.notify("⚠️ 缺少飞书凭证，无法启动网关", "warning");
		return;
	}
	// 派生 detach 孤儿进程：直接跑 bin 启动器（node + jiti）。
	// stdio 重定向（D1）：stdout/stderr 追加到 gateway.log，SDK 默认 console 日志在进程层面被捕获（零注入）；
	// windowsHide：不建新控制台（弹窗治理）
	fs.mkdirSync(path.dirname(GATEWAY_LOG_PATH), { recursive: true });
	const out = fs.openSync(GATEWAY_LOG_PATH, "a");
	const err = fs.openSync(GATEWAY_LOG_PATH, "a");
	const launcher = path.resolve(__dirname, "../../bin/pi-feishu-gateway.js");
	const child = childProcess.spawn(process.execPath, [launcher], {
		detached: true,
		stdio: ["ignore", out, err],
		windowsHide: true,
	});
	child.on("spawn", () => {
		fs.closeSync(out);
		fs.closeSync(err);
	});
	child.on("error", () => {
		try { fs.closeSync(out); } catch { /* 已关 */ }
		try { fs.closeSync(err); } catch { /* 已关 */ }
	});
	child.unref();
	ctx.ui.notify(`✅ 网关已启动（PID ${child.pid}），日志: ${GATEWAY_LOG_PATH}`, "info");
}

export function gatewayOff(ctx: GatewayCommandCtx): void {
	const pids = findGatewayPids();
	if (pids.length === 0) {
		ctx.ui.notify("网关未运行", "info");
		return;
	}
	const killed: number[] = [];
	for (const pid of pids) {
		try {
			process.kill(pid);
			killed.push(pid);
		} catch {
			// 已死或无权限，跳过
		}
	}
	ctx.ui.notify(
		killed.length > 0
			? `网关已停止（PID ${killed.join("、")}）`
			: "网关进程已不存在",
		"info",
	);
}

export function gatewayStatus(
	ctx: GatewayCommandCtx,
	claims: ClaimEntry[],
): void {
	const lock = readLock();
	const running = isLockValid();
	ctx.ui.notify(
		`网关状态: ${running ? `✅ 运行中（PID ${lock?.pid}）` : "未运行"}\n` +
			`follow 会话:\n${claims
				.map((e) => {
					const age = Math.round(
						(Date.now() - (e.heartbeat ?? e.claimedAt)) / 1000,
					);
					return `- ${e.sessionName}（${isAlive(e) ? "存活" : "离线"}，心跳 ${age}s 前）`;
				})
				.join("\n") || "- （无）"}`,
		"info",
	);
}
