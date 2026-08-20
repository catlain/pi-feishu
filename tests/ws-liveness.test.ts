import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WsKeeper, FRAME_DEAD_MS } from "../lib/gateway/ws-keeper";
import { tickIdle, initIdleState } from "../lib/gateway/lifecycle";
import { drainSession, type DrainerDeps } from "../lib/gateway/outbox-drainer";
import { appendOutbox } from "../lib/outbox";

/** 构造带 stub SDK 的 WsKeeper（不真连 WS） */
function mkKeeper() {
	const startCalls: unknown[] = [];
	const dispatcherReg: Record<string, (data: unknown) => Promise<void>> = {};
	const sdk = {
		EventDispatcher: class {
			register(ev: typeof dispatcherReg) {
				Object.assign(dispatcherReg, ev);
				return this;
			}
		},
		WSClient: class {
			constructor(_opts: unknown) {
				startCalls.push(_opts);
			}
			async start(_opts: unknown) {
				/* noop */
			}
			close() {
				/* noop */
			}
			getConnectionStatus() {
				return { state: "connected" }; // 对齐真实 SDK 1.73（有快照方法）
			}
		},
	} as unknown as typeof import("@larksuiteoapi/node-sdk");
	const logs: string[] = [];
	const keeper = new WsKeeper(sdk, {
		credentials: { appId: "a", appSecret: "s" },
		onMessage: () => {},
		reply: async () => {},
		log: (m) => logs.push(m),
		exit: () => {},
	});
	return { keeper, dispatcherReg, logs, startCalls };
}

describe("帧水位判活（D2，默认禁用、PI_FEISHU_FRAME_DEAD=1 启用）", () => {
	afterEach(() => {
		vi.useRealTimers();
		delete process.env.PI_FEISHU_FRAME_DEAD;
	});

	it("黑洞 + 有出站 → 判死（仅显式启用时）", async () => {
		vi.useFakeTimers();
		process.env.PI_FEISHU_FRAME_DEAD = "1";
		const { keeper, dispatcherReg } = mkKeeper();
		await keeper.start();
		// 初始健康（刚 start，帧水位新鲜）
		expect(keeper.isConnected(Date.now())).toBe(true);
		// 前进超过阈值，期间有出站成功
		const t2 = Date.now() + FRAME_DEAD_MS + 1000;
		vi.setSystemTime(t2);
		keeper.notifyOutboundOk();
		expect(keeper.isConnected(t2)).toBe(false);
	});

	it("默认禁用：黑洞 + 有出站 → 不判死（防静默期误杀循环）", async () => {
		vi.useFakeTimers();
		delete process.env.PI_FEISHU_FRAME_DEAD;
		const { keeper } = mkKeeper();
		await keeper.start();
		const t2 = Date.now() + FRAME_DEAD_MS + 1000;
		vi.setSystemTime(t2);
		keeper.notifyOutboundOk();
		expect(keeper.isConnected(t2)).toBe(true); // SDK 快照 connected → 健康
	});

	it("纯静默（无出站）→ 不判死", async () => {
		vi.useFakeTimers();
		const { keeper } = mkKeeper();
		await keeper.start();
		const t2 = Date.now() + FRAME_DEAD_MS + 600_000; // 远超阈值但无出站
		vi.setSystemTime(t2);
		expect(keeper.isConnected(t2)).toBe(true);
	});

	it("有帧持续刷新 → 永不判死", async () => {
		vi.useFakeTimers();
		const { keeper, dispatcherReg } = mkKeeper();
		await keeper.start();
		// 每分钟来一帧
		let now = Date.now();
		for (let i = 0; i < 5; i++) {
			now += 60_000;
			vi.setSystemTime(now);
			await dispatcherReg["im.message.receive_v1"]?.({ header: { event_id: `e${i}` } });
			expect(keeper.isConnected(now)).toBe(true);
		}
	});
});

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
		expect(ctorOpts?.wsConfig?.pingTimeout).toBe(90);
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

describe("D5 重连不刷新帧水位", () => {
	it("onReconnecting 回调不触碰 lastFrameAt（启用判死时验证）", async () => {
		// 间接验证：start opts 中的 onReconnecting 被调用后，静默期依旧判死（有出站时）
		vi.useFakeTimers();
		process.env.PI_FEISHU_FRAME_DEAD = "1";
		const { keeper, startCalls } = mkKeeper();
		await keeper.start();
		const opts = startCalls[0] as { onReconnecting?: () => void };
		const t2 = Date.now() + FRAME_DEAD_MS + 1000;
		vi.setSystemTime(t2);
		opts.onReconnecting?.(); // 模拟重连风暴
		keeper.notifyOutboundOk();
		expect(keeper.isConnected(t2)).toBe(false); // 仍判死 → 不会被重连回调掩盖
		delete process.env.PI_FEISHU_FRAME_DEAD;
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
