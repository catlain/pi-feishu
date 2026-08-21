/**
 * T2 竞争扫描异步消费 + T4 观测转正（diag 节流/重连群播/参数可见性）用例
 * 判活机制用例见 ws-liveness.test.ts
 */

import { describe, expect, it, vi } from "vitest";
import { mkKeeper, type Rivals } from "./helpers/mk-keeper";

describe("T2 竞争扫描异步消费（30s 循环内零同步子进程调用）", () => {
	it("循环触发 checkCompeting，结果经回调群播警告（5 分钟节流）", async () => {
		vi.useFakeTimers();
		const replies: string[] = [];
		const checkCompeting = vi.fn((onResult: (r: Rivals) => void) => {
			onResult([{ pid: 4242, cmd: "node t1-verify.mjs --feishu" }]);
		});
		const { keeper, logs } = mkKeeper({ replies, checkCompeting });
		await keeper.start();
		keeper.startReconnectLoop(() => {});
		vi.advanceTimersByTime(30_000 + 1);
		expect(checkCompeting).toHaveBeenCalledTimes(1);
		expect(replies.some((r) => r.includes("4242"))).toBe(true);
		expect(logs.some((l) => l.includes("竞争飞书 WS 客户端"))).toBe(true);
		// 5 分钟节流：后续循环不重复扫描
		vi.advanceTimersByTime(60_000);
		expect(checkCompeting).toHaveBeenCalledTimes(1);
		keeper.stop();
		vi.useRealTimers();
	});

	it("回调无竞争 → 不群播", async () => {
		vi.useFakeTimers();
		const replies: string[] = [];
		const checkCompeting = vi.fn((onResult: (r: Rivals) => void) => onResult([]));
		const { keeper } = mkKeeper({ replies, checkCompeting });
		await keeper.start();
		keeper.startReconnectLoop(() => {});
		vi.advanceTimersByTime(30_000 + 1);
		expect(checkCompeting).toHaveBeenCalledTimes(1);
		expect(replies.filter((r) => r.includes("抢事件"))).toHaveLength(0);
		keeper.stop();
		vi.useRealTimers();
	});
});

describe("T4.2 watchdog 重连即时群播（60s 节流防风暴刷屏）", () => {
	it("onReconnecting 触发群播；60s 内重复触发不刷屏", async () => {
		vi.useFakeTimers();
		const replies: string[] = [];
		const { keeper, startOpts } = mkKeeper({ replies });
		await keeper.start();
		startOpts[0]?.onReconnecting?.();
		expect(replies.some((r) => r.includes("连接重连中"))).toBe(true);
		replies.length = 0;
		vi.advanceTimersByTime(30_000); // 60s 节流窗内
		startOpts[0]?.onReconnecting?.();
		expect(replies.filter((r) => r.includes("连接重连中"))).toHaveLength(0);
		vi.advanceTimersByTime(35_000); // 窗外
		startOpts[0]?.onReconnecting?.();
		expect(replies.some((r) => r.includes("连接重连中"))).toBe(true);
		vi.useRealTimers();
	});
});

describe("T4.1/T4.3 diag 快照 5 分钟节流 + watchdog 参数可见性", () => {
	it("首拍立即、节流内静默、300s 后再现；快照附带 pingTimeout 与服务端 pingInterval", async () => {
		vi.useFakeTimers();
		const { keeper, logs } = mkKeeper({ serverPingIntervalMs: 120_000 });
		await keeper.start();
		keeper.diagSnapshot();
		expect(
			logs.some(
				(l) =>
					l.includes("[diag] 健康快照") &&
					l.includes("pingTimeout=240s") &&
					l.includes("服务端pingInterval=120s"),
			),
		).toBe(true);
		logs.length = 0;
		vi.advanceTimersByTime(30_000); // main.ts 30s 循环里再调
		keeper.diagSnapshot();
		expect(logs.filter((l) => l.includes("[diag]"))).toHaveLength(0); // 节流内不拍
		vi.advanceTimersByTime(270_000); // 累计 300s
		keeper.diagSnapshot();
		expect(logs.some((l) => l.includes("[diag] 健康快照"))).toBe(true);
		vi.useRealTimers();
	});

	it("参数倒挂（服务端 pingInterval ≥ pingTimeout）→ warn", async () => {
		const { keeper, logs } = mkKeeper({ serverPingIntervalMs: 300_000 });
		await keeper.start();
		keeper.diagSnapshot();
		expect(logs.some((l) => l.includes("参数倒挂"))).toBe(true);
	});

	it("启动日志打印生效 pingTimeout（参数炸弹可被日志一眼发现）", async () => {
		const { keeper, logs } = mkKeeper();
		await keeper.start();
		expect(logs.some((l) => l.includes("watchdog 参数: pingTimeout=240s"))).toBe(true);
	});
});
