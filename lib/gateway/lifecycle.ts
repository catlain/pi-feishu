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

// ── 空闲自退状态机 ──

export const GRACE_MS = 10 * 60_000;      // 启动宽限 10 分钟
export const IDLE_EXIT_MS = 10 * 60_000;  // 连续 10 分钟无存活心跳

export interface IdleState {
	/** 网关启动时间戳 */
	startedAt: number;
	/** 连续无存活心跳的开始时间（null = 当前有存活） */
	idleSince: number | null;
}

export function initIdleState(now: number = Date.now()): IdleState {
	return { startedAt: now, idleSince: null };
}

/**
 * 每次心跳扫描（30s）推进状态机。
 * 返回 true 表示应自退（宽限期内永不返回 true）。
 */
export function tickIdle(
	state: IdleState,
	anyAlive: boolean,
	now: number = Date.now(),
): boolean {
	if (anyAlive) {
		state.idleSince = null;
		return false;
	}
	if (state.idleSince === null) state.idleSince = now;
	if (now - state.startedAt < GRACE_MS) return false; // 宽限期防误杀
	return now - state.idleSince >= IDLE_EXIT_MS;
}
