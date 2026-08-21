/**
 * 网关生命周期 — 单例锁与空闲自退状态机（纯逻辑，可测）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { GATEWAY_LOCK_PATH } from "../claim";

export interface GatewayLock {
	pid: number;
	startedAt: number;
}

export function readLock(lockPath = GATEWAY_LOCK_PATH): GatewayLock | null {
	try {
		const data = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as GatewayLock;
		if (data && typeof data.pid === "number") {
			return { pid: data.pid, startedAt: data.startedAt ?? Date.now() };
		}
	} catch {
		// 不存在或损坏 → 无锁
	}
	return null;
}

export function writeLock(pid: number, lockPath = GATEWAY_LOCK_PATH): void {
	fs.mkdirSync(path.dirname(lockPath), { recursive: true });
	fs.writeFileSync(
		lockPath,
		JSON.stringify({ pid, startedAt: Date.now() }, null, 2) + "\n",
		"utf-8",
	);
}

export function clearLock(lockPath = GATEWAY_LOCK_PATH): void {
	try {
		fs.unlinkSync(lockPath);
	} catch {
		// 不存在即无事
	}
}

/** 进程是否存在（Windows 下 EPERM 也代表存在） */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		return code === "EPERM";
	}
}

/** 锁是否对应存活进程（残留锁自动判定失效） */
export function isLockValid(lockPath = GATEWAY_LOCK_PATH): boolean {
	const lock = readLock(lockPath);
	if (!lock) return false;
	return isProcessAlive(lock.pid);
}

// 注：WS 判活/重连/退避状态机与空闲自退状态机已随 feishu-gateway-simplify 整体退役
// （连接管理全权交 SDK、网关常驻不自退，见 openspec changes/feishu-gateway-simplify）。
