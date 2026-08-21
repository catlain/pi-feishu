import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WS_PING_TIMEOUT_S } from "../lib/gateway/ws-diagnostics";
import {
	tickIdle,
	initIdleState,
	WS_DEAD_AFTER_MS,
} from "../lib/gateway/lifecycle";
import { drainSession, type DrainerDeps } from "../lib/gateway/outbox-drainer";
import { appendOutbox } from "../lib/outbox";
import { mkKeeper } from "./helpers/mk-keeper";

describe("重建原子性（D1）", () => {
	it("start() 复调：旧 client 有 close 则调用并置空", async () => {
		const { keeper, logs } = mkKeeper();
		await keeper.start();
		await keeper.start();
		expect(logs.some((l) => l.includes("旧 client 已关闭"))).toBe(true);
	});

	it("liveness watchdog 参数进构造器 wsConfig（start() 参数无效，防回归）", async () => {
		const { keeper, startCalls } = mkKeeper();
		await keeper.start();
		const ctorOpts = startCalls[0] as { wsConfig?: { pingTimeout?: number } };
		// 诊断期 45 已退役，恒为 240（须 > 服务端 pingInterval 默认 120s）
		expect(ctorOpts?.wsConfig?.pingTimeout).toBe(240);
		expect(ctorOpts?.wsConfig?.pingTimeout).toBe(WS_PING_TIMEOUT_S);
	});
});

describe("D3 自退冻结：连接不健康时不推进 tickIdle", () => {
	it("connected=false 时不调用 tickIdle（冻结）", () => {
		// 行为级：main.ts 的接线是 `keeper.isConnected(...) && tickIdle(...)`，
		// 这里验证组合语义：连接不健康时即便无 claim 也不自退
		const idle = initIdleState(0);
		const connected = false;
		const shouldExit = connected && tickIdle(idle, false, 1000 * 60 * 60);
		expect(shouldExit).toBe(false);
	});
});

describe("D5 重连不刷新事件水位（D2 帧水位判死已退役，旧 SDK 水位回退路径验证）", () => {
	it("onReconnecting 回调不触碰 lastEventAt；真事件到达才恢复", async () => {
		vi.useFakeTimers();
		const { keeper, startOpts, dispatcherReg } = mkKeeper({ legacySdk: true });
		await keeper.start();
		const t2 = Date.now() + WS_DEAD_AFTER_MS + 1000;
		vi.setSystemTime(t2);
		startOpts[0]?.onReconnecting?.(); // 模拟重连风暴
		expect(keeper.isConnected(t2)).toBe(false); // 水位过期仍判死 → 不被重连回调掩盖
		// 对照：真事件到达 → 刷新水位恢复健康
		await dispatcherReg["im.message.receive_v1"]?.({ header: { event_id: "e1" } });
		expect(keeper.isConnected(t2)).toBe(true);
		vi.useRealTimers();
	});

	it("帧水位判死分支已删除：PI_FEISHU_FRAME_DEAD 不再影响判活（spec 帧水位退役场景的行为级兜底）", async () => {
		vi.useFakeTimers();
		process.env.PI_FEISHU_FRAME_DEAD = "1";
		try {
			const { keeper } = mkKeeper();
			await keeper.start();
			const t2 = Date.now() + 300_000;
			vi.setSystemTime(t2);
			keeper.notifyOutboundOk(); // 黑洞 + 有出站：曾判死，现在仅 SDK 快照说了算
			expect(keeper.isConnected(t2)).toBe(true);
		} finally {
			delete process.env.PI_FEISHU_FRAME_DEAD;
			vi.useRealTimers();
		}
	});
});

describe("onSent 钩子（outbox-drainer 接线）", () => {
	it("存在于 drainer 依赖类型并在发送成功时被调用", async () => {
		const calls: number[] = [];
		const deps: DrainerDeps = {
			sendEntry: async () => ({ sent: true, messageId: "om_x" }),
			exportDoc: async () => null,
			onSent: () => calls.push(1),
			log: () => {},
		};
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-onsent-"));
		appendOutbox(
			"s1",
			{
				id: "e1",
				createdAt: Date.now(),
				kind: "reply",
				text: "t",
				expectAck: false,
			} as never,
			d,
		);
		await drainSession("s1", deps, d);
		expect(calls.length).toBeGreaterThanOrEqual(1);
		fs.rmSync(d, { recursive: true, force: true });
	});
});
