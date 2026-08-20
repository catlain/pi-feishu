import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	readLock,
	writeLock,
	clearLock,
	isLockValid,
	isProcessAlive,
	initIdleState,
	tickIdle,
	GRACE_MS,
	IDLE_EXIT_MS,
} from "../lib/gateway/lifecycle";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-lock-"));
const lockPath = path.join(tmpDir, "gateway.lock");

beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe("gateway.lock 读写", () => {
	it("写后可读，clear 后为空", () => {
		writeLock(12345, lockPath);
		expect(readLock(lockPath)?.pid).toBe(12345);
		clearLock(lockPath);
		expect(readLock(lockPath)).toBeNull();
		clearLock(lockPath); // 不抛错
	});

	it("损坏文件返回 null", () => {
		fs.writeFileSync(lockPath, "{bad", "utf-8");
		expect(readLock(lockPath)).toBeNull();
	});
});

describe("进程/锁校验", () => {
	it("isProcessAlive：自己存活、不存在的 PID 不存活", () => {
		expect(isProcessAlive(process.pid)).toBe(true);
		// Windows 上 PID 空间大，取一个几乎不可能存在的
		expect(isProcessAlive(999_999_999)).toBe(false);
	});

	it("isLockValid：本进程锁有效，死进程锁无效", () => {
		writeLock(process.pid, lockPath);
		expect(isLockValid(lockPath)).toBe(true);
		writeLock(999_999_999, lockPath);
		expect(isLockValid(lockPath)).toBe(false);
	});
});

describe("空闲自退状态机", () => {
	it("宽限期内（启动 <10min）即使全离线也不退出", () => {
		const st = initIdleState(0);
		expect(tickIdle(st, false, 5 * 60_000)).toBe(false);
		expect(tickIdle(st, false, GRACE_MS - 1)).toBe(false);
	});

	it("宽限期后连续 10 分钟无存活 → 退出", () => {
		const st = initIdleState(0);
		// 宽限期刚过，开始计 idle
		expect(tickIdle(st, false, GRACE_MS + 1)).toBe(false);
		// idle 累计满 10 分钟 → 退出
		expect(tickIdle(st, false, GRACE_MS + 1 + IDLE_EXIT_MS)).toBe(true);
	});

	it("恢复：中途有存活会重置 idleSince", () => {
		const st = initIdleState(0);
		tickIdle(st, false, GRACE_MS + 60_000); // idle 开始
		tickIdle(st, true, GRACE_MS + 120_000); // 恢复
		expect(tickIdle(st, false, GRACE_MS + 130_000)).toBe(false); // 重新计数
		expect(tickIdle(st, false, GRACE_MS + 130_000 + IDLE_EXIT_MS - 1)).toBe(false);
		expect(tickIdle(st, false, GRACE_MS + 130_000 + IDLE_EXIT_MS)).toBe(true);
	});
});
