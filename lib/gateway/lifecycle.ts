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

// ── WS 断线检测与重连 ──

/** 水位判死阈值：3 分钟无任何 ws 事件（飞书 ping 周期约 30s） */
export const WS_DEAD_AFTER_MS = 3 * 60_000;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
export const RECONNECT_GIVEUP_MS = 30 * 60_000;

/** 水位判死：最近 ws 事件距今超过阈值 */
export function isWsDead(lastEventAt: number, now: number): boolean {
	return now - lastEventAt > WS_DEAD_AFTER_MS;
}

export interface ReconnectState {
	/** 连接存活时为 null；断开后为首次断开时间戳 */
	deadSince: number | null;
	/** 连续重连失败次数（成功清零） */
	failures: number;
	/** 上次重连尝试时间戳（null = 尚未尝试） */
	lastAttempt: number | null;
}

export function initReconnectState(): ReconnectState {
	return { deadSince: null, failures: 0, lastAttempt: null };
}

export type ReconnectAction =
	| { action: "none" }                       // 连接正常或等待退避
	| { action: "reconnect"; delayMs: number }  // 到点，立即重建（delayMs 仅日志用）
	| { action: "giveup" };                     // 持续失败超过 30 分钟，熔断退出

/**
 * 每次扫描 tick 推进重连状态机（与空闲自退共用 30s 周期也可更密）。
 * connected: 当前连接是否存活（事件/水位综合判定）。
 */
export function tickReconnect(
	state: ReconnectState,
	connected: boolean,
	now: number = Date.now(),
): ReconnectAction {
	if (connected) {
		if (state.deadSince !== null) {
			// 刚恢复：清零（群播报由调用方做）
			state.deadSince = null;
			state.failures = 0;
			state.lastAttempt = null;
		}
		return { action: "none" };
	}
	// 断开
	if (state.deadSince === null) state.deadSince = now;
	if (now - state.deadSince >= RECONNECT_GIVEUP_MS) return { action: "giveup" };
	// 退避到点？
	const backoff = Math.min(
		RECONNECT_BASE_MS * 2 ** Math.min(state.failures, 6),
		RECONNECT_MAX_MS,
	);
	if (state.lastAttempt === null || now - state.lastAttempt >= backoff) {
		state.lastAttempt = now;
		state.failures++;
		return { action: "reconnect", delayMs: backoff };
	}
	return { action: "none" };
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
