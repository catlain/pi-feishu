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
