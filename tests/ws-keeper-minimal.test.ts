/**
 * WsKeeper 极简面用例 — eventId 去重（feishu-gateway-simplify 后仅存的核心逻辑）
 * 原 ws-liveness / ws-observability 用例已随判活/重连/观测脚手架删除。
 */

import { describe, expect, it } from "vitest";
import { WsKeeper } from "../lib/gateway/ws-keeper";
import { MessageIdDedup } from "../lib/gateway/poller-core";
import { drainSession, type DrainerDeps } from "../lib/gateway/outbox-drainer";
import { appendOutbox } from "../lib/outbox";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mkKeeper } from "./helpers/mk-keeper";

describe("eventId 去重（防官方 3s 超时重推）", () => {
	it("schema 2.0 顶层 event_id：重复送达只分发一次", async () => {
		const messages: unknown[] = [];
		const { keeper, dispatcherReg, logs } = mkKeeper({ messages });
		await keeper.start();
		const handler = dispatcherReg["im.message.receive_v1"];
		expect(handler).toBeTruthy();
		await handler?.({ event_id: "e1", data: "x" });
		await handler?.({ event_id: "e1", data: "x" }); // 官方重推
		await handler?.({ event_id: "e1", data: "x" });
		expect(messages).toHaveLength(1);
		expect(logs.some((l) => l.includes("重复事件丢弃（eventId=e1"))).toBe(true);
	});

	it("旧 schema header.event_id 同样去重（双读兼容）", async () => {
		const messages: unknown[] = [];
		const { keeper, dispatcherReg } = mkKeeper({ messages });
		await keeper.start();
		const handler = dispatcherReg["im.message.receive_v1"];
		await handler?.({ header: { event_id: "h1" } });
		await handler?.({ header: { event_id: "h1" } });
		expect(messages).toHaveLength(1);
	});

	it("无 event_id 的事件不去重（原样分发）", async () => {
		const messages: unknown[] = [];
		const { keeper, dispatcherReg } = mkKeeper({ messages });
		await keeper.start();
		const handler = dispatcherReg["im.message.receive_v1"];
		await handler?.({ data: "a" });
		await handler?.({ data: "b" });
		expect(messages).toHaveLength(2);
	});

	it("滚动窗口：超过 256 条后最旧的 eventId 可再次处理", async () => {
		const messages: unknown[] = [];
		const { keeper, dispatcherReg } = mkKeeper({ messages });
		await keeper.start();
		const handler = dispatcherReg["im.message.receive_v1"];
		await handler?.({ event_id: "first" });
		for (let i = 0; i < 256; i++) {
			await handler?.({ event_id: `bulk-${i}` });
		}
		// "first" 已滑出窗口 → 不再被去重
		await handler?.({ event_id: "first" });
		expect(messages.filter((m) => (m as { event_id?: string }).event_id === "first")).toHaveLength(2);
	});

	it("onMessage 抛异常不冒泡（记录日志继续运行）", async () => {
		const logs: string[] = [];
		let dispatcherReg: Record<string, (data: unknown) => Promise<void>> = {};
		class FakeWS {
			async start() {}
			close() {}
		}
		const sdk = {
			LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
			EventDispatcher: class {
				register(ev: typeof dispatcherReg) {
					Object.assign(dispatcherReg, ev);
					return this;
				}
			},
			WSClient: FakeWS,
		} as unknown as typeof import("@larksuiteoapi/node-sdk");
		const keeper = new WsKeeper(sdk, {
			credentials: { appId: "a", appSecret: "s" },
			onMessage: () => {
				throw new Error("boom");
			},
			reply: async () => {},
			log: (m) => logs.push(m),
		});
		await keeper.start();
		await expect(
			dispatcherReg["im.message.receive_v1"]?.({ event_id: "e9" }),
		).resolves.toBeUndefined();
		expect(logs.some((l) => l.includes("boom"))).toBe(true);
	});
});

describe("SDK 构造零注入", () => {
	it("WSClient 构造参数：仅凭证（诊断参数已关，T5.3；实验代码见 ws-keeper 注释）", async () => {
		const { keeper, startCalls } = mkKeeper();
		await keeper.start();
		const ctorOpts = startCalls[0] as Record<string, unknown>;
		expect(ctorOpts).toEqual({ appId: "a", appSecret: "s" });
		expect("logger" in ctorOpts).toBe(false);
	});
});

describe("重连回调群播（保留的最小通知）", () => {
	it("onReconnecting / onReconnected 触发群播", async () => {
		const replies: string[] = [];
		const { keeper, startOpts } = mkKeeper({ replies });
		await keeper.start();
		startOpts[0]?.onReconnecting?.();
		startOpts[0]?.onReconnected?.();
		expect(replies.some((r) => r.includes("重连中"))).toBe(true);
		expect(replies.some((r) => r.includes("已恢复"))).toBe(true);
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
