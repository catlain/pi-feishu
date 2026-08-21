import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchPending } from "../lib/pending-dispatch";
import type { PendingCommand } from "../lib/pending";

// dispatchPending 的 ask-user-answer 通道测试（feishu-ask-multi-answer）
// mock fork 包 v3 命名导出（与 ask-user-answer.test.ts 同模式）
const askMock = vi.hoisted(() => ({
	params: null as unknown,
	submit: vi.fn((): boolean => true),
}));

vi.mock("@pi-atelier/rpiv-ask-user", () => ({
	getActiveAskParams: () => askMock.params,
	submitAskUserAnswer: askMock.submit,
	hasActiveAsk: () => askMock.params !== null,
}));

type Questionnaire = {
	questions: Array<{
		question?: string;
		options?: Array<{ label: string; description?: string }>;
	}>;
};

function mkState() {
	const sent: string[] = [];
	return {
		sent,
		selfSessionId: "s-test",
		sessionName: () => "a",
		config: { chatId: "c" },
		appendOutboxFn: (_sid: string, e: { text: string }) => {
			sent.push(e.text);
		},
		active: () => true,
		liveCtx: () => ({ isIdle: () => true }),
	} as unknown as import("../lib/handlers").HandlerState & { sent: string[] };
}

const singleQ: Questionnaire = {
	questions: [{ question: "用哪个方案？", options: [{ label: "A" }, { label: "B" }] }],
};

beforeEach(() => {
	askMock.params = null;
	askMock.submit.mockReset();
	askMock.submit.mockImplementation(() => true);
});

describe("dispatchPending", () => {
	it("kind=ask-user-answer 走代答通道（不注入文本）", async () => {
		askMock.params = singleQ;
		const st = mkState();
		const pending: PendingCommand = {
			command: "answer 1",
			senderOpenId: "ou_x",
			arrivedAt: Date.now(),
			id: "pf-1",
			kind: "ask-user-answer",
			answerSpec: "1",
			answerIndex: 1,
		};
		const pi = { sendMessage: () => { throw new Error("不应注入文本"); } };
		dispatchPending(pi as never, st, pending, () => {});
		await new Promise((r) => setTimeout(r, 10));
		expect(st.sent[0]).toContain("已代答: 1");
	});

	it("旧 pending 文件只有 answerIndex（无 answerSpec）→ 双读兼容", async () => {
		askMock.params = singleQ;
		const st = mkState();
		const pending: PendingCommand = {
			command: "answer 2",
			senderOpenId: "ou_x",
			arrivedAt: Date.now(),
			id: "pf-3",
			kind: "ask-user-answer",
			answerIndex: 2,
		};
		const pi = { sendMessage: () => { throw new Error("不应注入文本"); } };
		dispatchPending(pi as never, st, pending, () => {});
		await new Promise((r) => setTimeout(r, 10));
		expect(st.sent[0]).toContain("已代答: 2");
	});

	it("submit 返回 false（校验拒绝/过期）→ 播报过期而非成功", async () => {
		askMock.params = singleQ;
		askMock.submit.mockImplementation(() => false);
		const st = mkState();
		const pending: PendingCommand = {
			command: "answer 1",
			senderOpenId: "ou_x",
			arrivedAt: Date.now(),
			id: "pf-4",
			kind: "ask-user-answer",
			answerSpec: "1",
			answerIndex: 1,
		};
		const pi = { sendMessage: () => { throw new Error("不应注入文本"); } };
		dispatchPending(pi as never, st, pending, () => {});
		await new Promise((r) => setTimeout(r, 10));
		expect(askMock.submit).toHaveBeenCalledTimes(1);
		expect(st.sent[0]).toContain("问卷已答复或已过期");
		expect(st.sent[0]).not.toContain("已代答");
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
