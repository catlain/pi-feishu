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
	initReconnectState,
	tickReconnect,
	isWsDead,
	WS_DEAD_AFTER_MS,
	RECONNECT_GIVEUP_MS,
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

describe("WS 断线检测与重连", () => {
	it("isWsDead 水位边界", () => {
		expect(isWsDead(0, WS_DEAD_AFTER_MS)).toBe(false);
		expect(isWsDead(0, WS_DEAD_AFTER_MS + 1)).toBe(true);
	});

	it("退避序列：1s→2s→4s→…封顶 60s", () => {
		const st = initReconnectState();
		let now = 0;
		const delays: number[] = [];
		for (let i = 0; i < 9; i++) {
			const r = tickReconnect(st, false, now);
			expect(r.action).toBe("reconnect");
			if (r.action === "reconnect") delays.push(r.delayMs);
			now += 61_000; // 每次都过退避窗口（但未到熔断）
		}
		expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
	});

	it("等待退避窗口内不重试", () => {
		const st = initReconnectState();
		expect(tickReconnect(st, false, 0).action).toBe("reconnect");
		expect(tickReconnect(st, false, 500).action).toBe("none"); // 未到退避（已翻倍为 2s）
		expect(tickReconnect(st, false, 2000).action).toBe("reconnect");
	});

	it("恢复连接后清零", () => {
		const st = initReconnectState();
		tickReconnect(st, false, 0);
		tickReconnect(st, false, 5000);
		expect(tickReconnect(st, true, 6000).action).toBe("none");
		expect(st.failures).toBe(0);
		expect(st.deadSince).toBeNull();
		// 新一轮断开从 1s 退避重新开始
		expect(tickReconnect(st, false, 7000)).toMatchObject({ action: "reconnect", delayMs: 1000 });
	});

	it("持续失败超 30 分钟熔断 giveup（边界）", () => {
		const st = initReconnectState();
		tickReconnect(st, false, 0); // deadSince=0 并首次重试
		expect(tickReconnect(st, false, RECONNECT_GIVEUP_MS - 1).action).not.toBe("giveup");
		expect(tickReconnect(st, false, RECONNECT_GIVEUP_MS).action).toBe("giveup");
	});
});
