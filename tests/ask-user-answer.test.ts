import { afterEach, describe, expect, it } from "vitest";
import { consumeAskUserAnswer } from "../lib/handlers";
import { dispatchPending } from "../lib/pending-dispatch";
import type { PendingCommand } from "../lib/pending";

// 模拟 fork 包在 globalThis 上注册的 API（pi-feishu 零依赖消费该入口）
const API = Symbol.for("@pi-atelier/rpiv-ask-user/api");

type Questionnaire = {
	questions: Array<{
		question?: string;
		header?: string;
		multiSelect?: boolean;
		options?: Array<{ label: string; description?: string }>;
	}>;
};
type Answer = {
	answers: Array<{
		questionIndex: number;
		question?: string;
		kind: "option" | "custom" | "multi";
		answer?: string | null;
		selected?: string[];
	}>;
	cancelled: boolean;
};

function installApi(params: Questionnaire | null, resolve: (ok: boolean) => void = () => {}, capture?: (a: Answer) => void) {
	const store = globalThis as Record<symbol, unknown>;
	store[API] = {
		getActiveAskParams: () => params,
		submitAskUserAnswer: (r: Answer) => {
			if (!params) return false;
			capture?.(r);
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
	} as unknown as import("../lib/handlers").HandlerState & { sent: string[] };
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

// 3 题混合问卷：单选 + 多选 + 单选（末题可作自定义）
const mixed3Q: Questionnaire = {
	questions: [
		{
			question: "用哪个库？",
			options: [{ label: "libA" }, { label: "libB" }, { label: "libC" }],
		},
		{
			question: "启用哪些功能？",
			multiSelect: true,
			options: [{ label: "x" }, { label: "y" }, { label: "z" }],
		},
		{
			question: "端口？",
			options: [{ label: "80" }, { label: "443" }],
		},
	],
};

afterEach(() => {
	clearApi();
});

describe("consumeAskUserAnswer", () => {
	it("无全局入口（fork 未安装）→ 播报过期", async () => {
		const st = mkState();
		await consumeAskUserAnswer(st, "1", "ou_x");
		expect(st.sent[0]).toContain("问卷已答复或已过期");
	});

	it("无活跃问卷 → 播报过期", async () => {
		const st = mkState();
		installApi(null);
		await consumeAskUserAnswer(st, "1", "ou_x");
		expect(st.sent[0]).toContain("问卷已答复或已过期");
	});

	it("单题旧语法编号 → 代答成功并播报", async () => {
		const st = mkState();
		let captured: Answer | undefined;
		installApi(singleQ, () => {}, (a) => (captured = a));
		await consumeAskUserAnswer(st, "2", "ou_x");
		expect(st.sent[0]).toContain("已代答: 2");
		expect(captured!.answers[0]).toEqual({ questionIndex: 0, question: "用哪个方案？", kind: "option", answer: "B" });
	});

	it("编号越界 → 提示无效", async () => {
		const st = mkState();
		installApi(singleQ);
		await consumeAskUserAnswer(st, "9", "ou_x");
		expect(st.sent[0]).toContain("编号 9 无效");
	});

	it("多题问卷 → 代答成功（不再拒绝）", async () => {
		const st = mkState();
		let captured: Answer | undefined;
		installApi(mixed3Q, () => {}, (a) => (captured = a));
		await consumeAskUserAnswer(st, "2,1|3,=8080", "ou_x");
		expect(st.sent[0]).toContain("已代答: 2,1|3,=8080");
		expect(captured!.answers).toHaveLength(3);
		expect(captured!.answers[1]).toEqual({
			questionIndex: 1,
			question: "启用哪些功能？",
			kind: "multi",
			selected: ["x", "z"],
			answer: null,
		});
		expect(captured!.answers[2]).toEqual({
			questionIndex: 2,
			question: "端口？",
			kind: "custom",
			answer: "8080",
		});
	});

	it("多题错误段 → 逐题错误提示，问卷保持等待", async () => {
		const st = mkState();
		let submitted = false;
		installApi(mixed3Q, () => {}, () => (submitted = true));
		await consumeAskUserAnswer(st, "2,9,=8080", "ou_x");
		expect(st.sent[0]).toContain("问题2 编号 9 无效，共 3 个选项");
		expect(submitted).toBe(false);
	});
});

