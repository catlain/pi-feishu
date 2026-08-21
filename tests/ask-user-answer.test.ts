import { beforeEach, describe, expect, it, vi } from "vitest";
import { consumeAskUserAnswer } from "../lib/handlers";

// mock fork 包 v3 命名导出（真实包 submit 会对照 params 逐条校验答案；
// 这里按用例配置 getActiveAskParams 快照与 submit 行为，验证 handlers 侧分支）
const askMock = vi.hoisted(() => ({
	params: null as unknown,
	submit: vi.fn((_r: { answers: unknown[]; cancelled: boolean }): boolean => true),
}));

vi.mock("@pi-atelier/rpiv-ask-user", () => ({
	getActiveAskParams: () => askMock.params,
	submitAskUserAnswer: askMock.submit,
	hasActiveAsk: () => askMock.params !== null,
}));

type Questionnaire = {
	questions: Array<{
		question?: string;
		header?: string;
		multiSelect?: boolean;
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

beforeEach(() => {
	askMock.params = null;
	askMock.submit.mockReset();
	askMock.submit.mockImplementation(() => true);
});

describe("consumeAskUserAnswer", () => {
	it("无活跃问卷（getActiveAskParams=null）→ 播报过期", async () => {
		askMock.params = null;
		const st = mkState();
		await consumeAskUserAnswer(st, "1", "ou_x");
		expect(st.sent[0]).toContain("问卷已答复或已过期");
	});

	it("单题旧语法编号 → 代答成功并播报", async () => {
		askMock.params = singleQ;
		const st = mkState();
		await consumeAskUserAnswer(st, "2", "ou_x");
		expect(st.sent[0]).toContain("已代答: 2");
		expect(askMock.submit).toHaveBeenCalledTimes(1);
		const submitted = askMock.submit.mock.calls[0]![0] as {
			answers: Array<Record<string, unknown>>;
			cancelled: boolean;
		};		expect(submitted.cancelled).toBe(false);
		expect(submitted.answers[0]).toEqual({ questionIndex: 0, question: "用哪个方案？", kind: "option", answer: "B" });
	});

	it("编号越界 → 提示无效，不调 submit", async () => {
		askMock.params = singleQ;
		const st = mkState();
		await consumeAskUserAnswer(st, "9", "ou_x");
		expect(st.sent[0]).toContain("编号 9 无效");
		expect(askMock.submit).not.toHaveBeenCalled();
	});

	it("多题问卷 → 代答成功（不再拒绝）", async () => {
		askMock.params = mixed3Q;
		const st = mkState();
		await consumeAskUserAnswer(st, "2,1|3,=8080", "ou_x");
		expect(st.sent[0]).toContain("已代答: 2,1|3,=8080");
		const submitted = askMock.submit.mock.calls[0]![0] as {
			answers: Array<Record<string, unknown>>;
		};
		expect(submitted.answers).toHaveLength(3);
		expect(submitted.answers[1]).toEqual({
			questionIndex: 1,
			question: "启用哪些功能？",
			kind: "multi",
			selected: ["x", "z"],
			answer: null,
		});
		expect(submitted.answers[2]).toEqual({
			questionIndex: 2,
			question: "端口？",
			kind: "custom",
			answer: "8080",
		});
	});

	it("多题错误段 → 逐题错误提示，问卷保持等待", async () => {
		askMock.params = mixed3Q;
		const st = mkState();
		await consumeAskUserAnswer(st, "2,9,=8080", "ou_x");
		expect(st.sent[0]).toContain("问题2 编号 9 无效，共 3 个选项");
		expect(askMock.submit).not.toHaveBeenCalled();
	});

	it("submit 返回 false（v3 校验拒绝或问卷已被终端答复）→ 播报过期", async () => {
		askMock.params = singleQ;
		askMock.submit.mockImplementation(() => false);
		const st = mkState();
		await consumeAskUserAnswer(st, "1", "ou_x");
		expect(askMock.submit).toHaveBeenCalledTimes(1);
		expect(st.sent[0]).toContain("问卷已答复或已过期");
		expect(st.sent[0]).not.toContain("已代答");
	});
});
