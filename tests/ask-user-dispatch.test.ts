import { afterEach, describe, expect, it } from "vitest";
import { dispatchPending } from "../lib/pending-dispatch";
import type { PendingCommand } from "../lib/pending";

// dispatchPending 的 ask-user-answer 通道测试（feishu-ask-multi-answer）
// fork API mock：与 ask-user-answer.test.ts 同模式

const API = Symbol.for("@pi-atelier/rpiv-ask-user/api");

type Questionnaire = {
	questions: Array<{
		question?: string;
		options?: Array<{ label: string; description?: string }>;
	}>;
};

function installApi(params: Questionnaire | null) {
	const store = globalThis as Record<symbol, unknown>;
	store[API] = {
		getActiveAskParams: () => params,
		submitAskUserAnswer: () => params !== null,
	};
}

function clearApi() {
	delete (globalThis as Record<symbol, unknown>)[API];
}

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

afterEach(() => {
	clearApi();
});

describe("dispatchPending", () => {
	it("kind=ask-user-answer 走代答通道（不注入文本）", async () => {
		const st = mkState();
		installApi(singleQ);
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
		const st = mkState();
		installApi(singleQ);
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
