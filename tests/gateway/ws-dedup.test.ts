import { describe, it, expect } from "vitest";
import { WsKeeper } from "../../lib/gateway/ws-keeper";
import { MessageIdDedup } from "../../lib/gateway/poller-core";

describe("feishu-poll-primary：WS 分流与双键去重（T2.1/D5）", () => {
	interface Reg {
		dispatcherReg: Record<string, (data: unknown) => Promise<void>>;
	}
	function mkDedupKeeper(opts: {
		filter?: (d: unknown) => boolean;
		dedup?: import("../../lib/gateway/poller-core").MessageIdDedup;
		onMessage?: (d: unknown) => void;
	}): Reg {
		const reg: Reg = { dispatcherReg: {} };
		const sdk = {
			LoggerLevel: { fatal: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 },
			EventDispatcher: class {
				register(ev: Record<string, (data: unknown) => Promise<void>>) {
					Object.assign(reg.dispatcherReg, ev);
					return this;
				}
			},
			WSClient: class {
				async start() {}
				close() {}
			},
		} as unknown as typeof import("@larksuiteoapi/node-sdk");
		const keeper = new WsKeeper(sdk, {
			credentials: { appId: "a", appSecret: "s" },
			onMessage: opts.onMessage ?? (() => {}),
			reply: async () => {},
			log: () => {},
			filter: opts.filter,
			dedup: opts.dedup,
		});
		void keeper.start();
		return reg;
	}

	it("被 filter 丢弃的普通消息不加入去重集合（否则 Poller 也跳过 → 双通道双丢，真机实测回归）", async () => {
		const dedup = new MessageIdDedup();
		const { dispatcherReg } = mkDedupKeeper({
			filter: () => false, // 一律判为普通消息 → 全丢弃
			dedup,
		});
		await dispatcherReg["im.message.receive_v1"]?.({
			event_id: "e1",
			message: { message_id: "om-1", content: "{}" },
		});
		expect(dedup.has("om-1")).toBe(false); // 关键断言：丢弃 ≠ 已处理
	});

	it("命令类消息处理后标记去重；Poller 已处理的重复 WS 丢弃", async () => {
		const dedup = new MessageIdDedup();
		const handled: unknown[] = [];
		const { dispatcherReg } = mkDedupKeeper({
			filter: () => true, // 一律判为命令 → 处理
			dedup,
			onMessage: (d) => handled.push(d),
		});
		await dispatcherReg["im.message.receive_v1"]?.({
			event_id: "e1",
			message: { message_id: "om-1" },
		});
		expect(dedup.has("om-1")).toBe(true);
		expect(handled).toHaveLength(1);
		// Poller 已处理过的（集合中已有）→ WS 重复事件丢弃，不重复处理
		await dispatcherReg["im.message.receive_v1"]?.({
			event_id: "e2",
			message: { message_id: "om-1" },
		});
		expect(handled).toHaveLength(1);
	});
});
