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

// 注：空闲自退状态机与 WS 重连状态机已随 feishu-gateway-simplify 退役
// （网关常驻不自退、连接管理全权交 SDK），相关用例随功能删除。
