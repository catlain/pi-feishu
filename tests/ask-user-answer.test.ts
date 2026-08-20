import { afterEach, describe, expect, it } from "vitest";
import { clearActiveAsk, registerActiveAsk } from "@pi-atelier/rpiv-ask-user";
import { consumeAskUserAnswer } from "../lib/handlers";
import { dispatchPending } from "../lib/pending-dispatch";
import type { PendingCommand } from "../lib/pending";

function mkState() {
	const sent: string[] = [];
	return {
		sent,
		sessionName: () => "a",
		config: { chatId: "c" },
		sendText: async (_chat: string, text: string) => {
			sent.push(text);
		},
		active: () => true,
		liveCtx: () => ({ isIdle: () => true }),
	} as never;
}

const singleQ = {
	questions: [
		{
			question: "用哪个方案？",
			header: "方案",
			options: [
				{ label: "A", description: "快" },
				{ label: "B", description: "稳" },
			],
		},
	],
} as Parameters<typeof registerActiveAsk>[0];

afterEach(() => {
	clearActiveAsk();
});

describe("consumeAskUserAnswer", () => {
	it("无活跃问卷 → 播报过期", async () => {
		const st = mkState();
		await consumeAskUserAnswer(st, 1, "ou_x");
		expect(st.sent[0]).toContain("问卷已答复或已过期");
	});

	it("有效编号 → 代答成功并播报", async () => {
		const st = mkState();
		let resolved: unknown = null;
		registerActiveAsk(singleQ, (r) => {
			resolved = r;
		});
		await consumeAskUserAnswer(st, 2, "ou_x");
		expect(st.sent[0]).toContain("已代答: 2. B");
		expect((resolved as { answers: Array<{ answer: string }> }).answers[0].answer).toBe("B");
	});

	it("编号越界 → 提示无效", async () => {
		const st = mkState();
		registerActiveAsk(singleQ, () => {});
		await consumeAskUserAnswer(st, 9, "ou_x");
		expect(st.sent[0]).toContain("编号 9 无效");
	});

	it("多题问卷 → 提示回终端", async () => {
		const st = mkState();
		registerActiveAsk(
			{ questions: [...singleQ.questions, { question: "再问一句?", options: [{ label: "是" }] }] } as never,
			() => {},
		);
		await consumeAskUserAnswer(st, 1, "ou_x");
		expect(st.sent[0]).toContain("多题问卷暂不支持");
	});

	it("重复消费（已答）→ 播报过期", async () => {
		const st = mkState();
		registerActiveAsk(singleQ, () => {});
		await consumeAskUserAnswer(st, 1, "ou_x"); // 已答
		clearActiveAsk();
		await consumeAskUserAnswer(st, 1, "ou_x");
		expect(st.sent[1]).toContain("问卷已答复或已过期");
	});
});

describe("dispatchPending", () => {
	it("kind=ask-user-answer 走代答通道（不注入文本）", async () => {
		const st = mkState();
		let resolved = false;
		registerActiveAsk(singleQ, () => {
			resolved = true;
		});
		const pending: PendingCommand = {
			command: "answer 1",
			senderOpenId: "ou_x",
			arrivedAt: Date.now(),
			id: "pf-1",
			kind: "ask-user-answer",
			answerIndex: 1,
		};
		const pi = { sendMessage: () => { throw new Error("不应注入文本"); } };
		dispatchPending(pi as never, st, pending, () => {});
		await new Promise((r) => setTimeout(r, 10));
		expect(resolved).toBe(true);
		expect(st.sent[0]).toContain("已代答: 1. A");
	});

	it("普通指令走文本注入", () => {
		const sent: unknown[] = [];
		const pi = { sendMessage: (msg: unknown) => sent.push(msg) };
		dispatchPending(pi as never, mkState(), {
			command: "跑回测",
			senderOpenId: "ou_x",
			arrivedAt: Date.now(),
			id: "pf-2",
		}, () => {});
		expect(sent).toHaveLength(1);
	});
});
