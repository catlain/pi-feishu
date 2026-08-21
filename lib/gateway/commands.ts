/**
 * 网关生命周期命令 — /feishu-gateway on|off|status 的实现
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as childProcess from "node:child_process";
import type { ClaimEntry } from "../types";
import { isAlive, CLAIM_DIR, GATEWAY_LOG_PATH } from "../claim";
import {
	readLock,
	isLockValid,
	isProcessAlive,
	clearLock,
} from "./lifecycle";

/** 命令 ctx 的最小结构 */
export type GatewayCommandCtx = {
	ui: { notify: (msg: string, type?: "info" | "error" | "warning") => void };
};

/**
 * 扫描与飞书同 app 抢 WS 事件的竞争进程（验证脚本残留监听器等）。
 * 事件会被服务端随机分发给同 app 的所有 WS 连接 → 网关时通时不通的元凶。
 */
export function findCompetingFeishuClients(excludePid?: number): Array<{ pid: number; cmd: string }> {
	let out = "";
	try {
		if (process.platform === "win32") {
			// wmic 已从新 Windows 移除（报错噪音），直接 PowerShell CIM（CSV 输出格式对齐）
			out = childProcess
				.execSync(
					"powershell -NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"name='node.exe'\\\" | Select-Object ProcessId,CommandLine | ConvertTo-Csv -NoTypeInformation\"",
					{ encoding: "utf-8", timeout: 15000 },
				)
				.toString();
		} else {
			out = childProcess
				.execSync("ps -eo pid,args", { encoding: "utf-8", timeout: 8000 })
				.toString();
		}
	} catch {
		return []; // 扫描失败不阻塞命令
	}
	const found: Array<{ pid: number; cmd: string }> = [];
	for (const line of out.split("\n")) {
		if (!/feishu/i.test(line)) continue;
		// 网关本体（含软链路径差异）排除；本进程排除
		if (/pi-feishu-gateway(\\|\/|\.js|$)/.test(line)) continue;
		const pid = /(?:^|,)(\d+)\s*$/.exec(line.trim())?.[1];
		if (!pid || Number(pid) === process.pid || Number(pid) === excludePid) continue;
		found.push({ pid: Number(pid), cmd: line.trim().slice(0, 120) });
	}
	return found;
}

export function gatewayOn(
	ctx: GatewayCommandCtx,
	hasCredentials: boolean,
): void {
	if (!hasCredentials) {
		ctx.ui.notify("⚠️ 缺少飞书凭证，无法启动网关", "warning");
		return;
	}
	const lock = readLock();
	if (lock && isProcessAlive(lock.pid)) {
		ctx.ui.notify(`网关已运行（PID ${lock.pid}）`, "info");
		warnCompeting(ctx, lock.pid);
		return;
	}
	if (lock) {
		clearLock();
		ctx.ui.notify(`检测到残留锁（PID ${lock.pid} 已不存在），已作废`, "info");
	}
	// 派生 detach 孤儿进程：直接跑 bin 启动器（node + jiti），stdio 全部 ignore（网关内日志走文件流，父 fd 管道已死会 EPIPE）
	fs.mkdirSync(CLAIM_DIR, { recursive: true });
	const launcher = path.resolve(__dirname, "../../bin/pi-feishu-gateway.js");
	const child = childProcess.spawn(process.execPath, [launcher], {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	child.unref();
	ctx.ui.notify(`✅ 网关已启动（PID ${child.pid}），日志: ${GATEWAY_LOG_PATH}`, "info");
	warnCompeting(ctx, child.pid);
}

/** 发现同 app 竞争 WS 连接时提示用户（事件会被分流，网关时通时不通） */
function warnCompeting(ctx: GatewayCommandCtx, gatewayPid?: number): void {
	const rivals = findCompetingFeishuClients(gatewayPid);
	if (rivals.length === 0) return;
	ctx.ui.notify(
		`⚠️ 检测到 ${rivals.length} 个其他飞书 WS 客户端进程（验证脚本残留等），会抢走网关事件导致时通时不通：\n` +
			rivals.map((r) => `- PID ${r.pid}: ${r.cmd}`).join("\n") +
			"\n建议：taskkill //PID <pid> //F 清理后重试",
		"warning",
	);
}

export function gatewayOff(ctx: GatewayCommandCtx): void {
	const lock = readLock();
	if (!lock) {
		ctx.ui.notify("网关未运行", "info");
		return;
	}
	if (!isProcessAlive(lock.pid)) {
		clearLock();
		ctx.ui.notify("网关进程已不存在，锁已清除", "info");
		return;
	}
	try {
		process.kill(lock.pid);
		ctx.ui.notify(`网关已停止（PID ${lock.pid}）`, "info");
	} catch (err) {
		ctx.ui.notify(
			`停止失败: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		return;
	}
	clearLock();
}

export function gatewayStatus(
	ctx: GatewayCommandCtx,
	claims: ClaimEntry[],
): void {
	const lock = readLock();
	const running = isLockValid();
	warnCompeting(ctx, lock?.pid);
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
