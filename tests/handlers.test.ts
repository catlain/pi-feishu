import { describe, expect, it } from "vitest";
import { safeIsIdle, injectFeishuCommand } from "../lib/handlers";

describe("safeIsIdle", () => {
	it("正常 ctx 返回 isIdle 结果，失效 ctx 兜底 true", () => {
		expect(safeIsIdle({ isIdle: () => false })).toBe(false);
		expect(safeIsIdle({ isIdle: () => true })).toBe(true);
		expect(safeIsIdle({})).toBe(false); // 缺 isIdle 方法 → 非存活，视为忙
		expect(safeIsIdle({ isIdle: null })).toBe(false); // 同上
	});
});

describe("injectFeishuCommand 忙闲分流", () => {
	function mkPi() {
		const sent: Array<{ msg: unknown; opts: unknown }> = [];
		return {
			sent,
			sendMessage: (msg: unknown, opts: unknown) => {
				sent.push({ msg, opts });
			},
		};
	}
	function mkState(idle: boolean) {
		return {
			selfSessionId: "s1",
			sessionName: () => "a",
			config: { chatId: "c", whitelist: [], truncateThreshold: 0 },
			botOpenId: () => null,
			liveCtx: () => ({ isIdle: () => idle }),
			sendText: async () => null,
			rawClient: () => null,
			active: () => true,
		};
	}

	it("闲时 triggerTurn 新回合", () => {
		const pi = mkPi();
		injectFeishuCommand(pi as never, mkState(true) as never, "跑回测", "ou_x");
		expect(pi.sent).toHaveLength(1);
		expect(pi.sent[0]!.opts).toEqual({ triggerTurn: true });
		expect((pi.sent[0]!.msg as { customType: string }).customType).toBe(
			"feishu_message",
		);
		expect((pi.sent[0]!.msg as { display: boolean }).display).toBe(true);
	});

	it("忙时 steer 插话", () => {
		const pi = mkPi();
		injectFeishuCommand(pi as never, mkState(false) as never, "停一下", "ou_x");
		expect(pi.sent[0]!.opts).toEqual({ deliverAs: "steer" });
	});
});
