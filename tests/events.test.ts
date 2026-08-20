import { describe, expect, it } from "vitest";
import {
	extractText,
	isWhitelisted,
	parseCommand,
	parseInboundEvent,
	stripMentionPlaceholders,
} from "../lib/events";

const BOT = "ou_bot_123";

describe("事件解析", () => {
	// 真实事件 dump 回归（2026-06-20）：mentions/chat_id 在 message 层，sender 在顶层
	const REAL_EVENT = {
		schema: "2.0",
		event_id: "ev_1",
		event_type: "im.message.receive_v1",
		message: {
			chat_id: "oc_670632481857a95a4ff61a731c034218",
			content: '{"text":"@_user_1 list list list"}',
			mentions: [
				{
					id: { open_id: "ou_22effd5e7d84081e5fdc35bc61ea729b", union_id: "on_x", user_id: null },
					key: "@_user_1",
					mentioned_type: "bot",
					name: "pi-assistant",
				},
			],
		},
		sender: {
			sender_id: { open_id: "ou_105ece6b306a3cdbb03f810f0cc4c484", union_id: "on_y", user_id: null },
			sender_type: "user",
			tenant_key: "1741900dbf4c9740",
		},
	};
	const BOT = "ou_22effd5e7d84081e5fdc35bc61ea729b";

	it("真实事件 dump：mentions 在 message 层能匹配 @bot", () => {
		const r = parseInboundEvent(REAL_EVENT as never, BOT);
		expect(r.mentionedBot).toBe(true);
		expect(r.senderOpenId).toBe("ou_105ece6b306a3cdbb03f810f0cc4c484");
		expect(r.chatId).toBe("oc_670632481857a95a4ff61a731c034218");
		expect(r.text).toBe("list list list");
		expect(r.isSelfMessage).toBe(false);
	});

	it("顶层 mentions 兼容", () => {
		const r = parseInboundEvent(
			{
				mentions: [{ key: "@_user_1", id: { open_id: BOT } }],
				message: { content: '{"text":"@_user_1 hello"}' },
			},
			BOT,
		);
		expect(r.mentionedBot).toBe(true);
		expect(r.text).toBe("hello");
	});

	it("提及他人不算 @bot", () => {
		const r = parseInboundEvent(
			{
				mentions: [{ key: "@_user_1", id: { open_id: "ou_other" } }],
				message: { content: '{"text":"@_user_1 hi"}' },
			},
			BOT,
		);
		expect(r.mentionedBot).toBe(false);
	});

	it("无 mentions 不算 @bot（不依赖 text 匹配）", () => {
		const r = parseInboundEvent(
			{ message: { content: '{"text":"@_user_1 hi"}' } },
			BOT,
		);
		expect(r.mentionedBot).toBe(false);
	});

	it("sender open_id 取顶层 data.sender", () => {
		const r = parseInboundEvent(
			{
				sender: { sender_id: { open_id: "ou_user_1" } },
				message: { content: '{"text":"x"}' },
			},
			BOT,
		);
		expect(r.senderOpenId).toBe("ou_user_1");
	});

	it("自环过滤：sender_type 为 app", () => {
		const r = parseInboundEvent(
			{
				sender: { sender_type: "app", sender_id: { open_id: BOT } },
				mentions: [{ id: { open_id: BOT } }],
				message: { content: '{"text":"[pi:x] 播报"}' },
			},
			BOT,
		);
		expect(r.isSelfMessage).toBe(true);
	});

	it("chat_id 提取", () => {
		const r = parseInboundEvent(
			{ chat: { chat_id: "oc_1" }, message: { content: "{}" } },
			BOT,
		);
		expect(r.chatId).toBe("oc_1");
	});

	it("content JSON 异常容错", () => {
		expect(extractText("bad")).toBe("");
		expect(extractText('{"text":"ok"}')).toBe("ok");
		expect(stripMentionPlaceholders("@_user_1 跑回测")).toBe("跑回测");
	});
});

describe("白名单校验", () => {
	it("open_id 精确匹配", () => {
		expect(isWhitelisted("ou_1", ["ou_1"])).toBe(true);
		expect(isWhitelisted("ou_1", ["ou_2"])).toBe(false);
	});

	it("空名单默认拒绝", () => {
		expect(isWhitelisted("ou_1", [])).toBe(false);
	});

	it("null sender 拒绝", () => {
		expect(isWhitelisted(null, ["ou_1"])).toBe(false);
	});
});

describe("指令解析", () => {
	it("首词为会话名", () => {
		expect(parseCommand("quant 跑一下回测")).toEqual({
			sessionName: "quant",
			command: "跑一下回测",
		});
	});

	it("单词无指令", () => {
		expect(parseCommand("quant")).toEqual({ sessionName: "quant", command: "" });
	});

	it("空文本返回 null", () => {
		expect(parseCommand("")).toBeNull();
	});
});
