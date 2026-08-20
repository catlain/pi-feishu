import { afterEach, describe, expect, it } from "vitest";
import { consumeAskUserAnswer } from "../lib/handlers";
import { dispatchPending } from "../lib/pending-dispatch";
import type { PendingCommand } from "../lib/pending";

// 模拟 fork 包在 globalThis 上注册的 API（pi-feishu 零依赖消费该入口）
const API = Symbol.for("@pi-atelier/rpiv-ask-user/api");

type Questionnaire = {
	questions: Array<{ question?: string; header?: string; options?: Array<{ label: string; description?: string }> }>;
};
type Answer = { answers: Array<{ questionIndex: number; question?: string; kind: "option"; answer: string }>; cancelled: boolean };

function installApi(params: Questionnaire | null, resolve: (ok: boolean) => void = () => {}) {
	const store = globalThis as Record<symbol, unknown>;
	store[API] = {
		getActiveAskParams: () => params,
		submitAskUserAnswer: (r: Answer) => {
			if (!params) return false;
			resolve(true);
			return true;
		},
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
	} as never;
}

const singleQ: Questionnaire = {
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
};

afterEach(() => {
	clearApi();
});

describe("consumeAskUserAnswer", () => {
	it("无全局入口（fork 未安装）→ 播报过期", async () => {
		const st = mkState();
		await consumeAskUserAnswer(st, 1, "ou_x");
		expect(st.sent[0]).toContain("问卷已答复或已过期");
	});

	it("无活跃问卷 → 播报过期", async () => {
		const st = mkState();
		installApi(null);
		await consumeAskUserAnswer(st, 1, "ou_x");
		expect(st.sent[0]).toContain("问卷已答复或已过期");
	});

	it("有效编号 → 代答成功并播报", async () => {
		const st = mkState();
		let resolved = false;
		installApi(singleQ, (ok) => {
			resolved = ok;
		});
		await consumeAskUserAnswer(st, 2, "ou_x");
		expect(st.sent[0]).toContain("已代答: 2. B");
		expect(resolved).toBe(true);
	});

	it("编号越界 → 提示无效", async () => {
		const st = mkState();
		installApi(singleQ);
		await consumeAskUserAnswer(st, 9, "ou_x");
		expect(st.sent[0]).toContain("编号 9 无效");
	});

	it("多题问卷 → 提示回终端", async () => {
		const st = mkState();
		installApi({ questions: [...singleQ.questions, { question: "再问?", options: [{ label: "是" }] }] });
		await consumeAskUserAnswer(st, 1, "ou_x");
		expect(st.sent[0]).toContain("多题问卷暂不支持");
	});
});

describe("dispatchPending", () => {
	it("kind=ask-user-answer 走代答通道（不注入文本）", async () => {
		const st = mkState();
		let resolved = false;
		installApi(singleQ, () => {
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
