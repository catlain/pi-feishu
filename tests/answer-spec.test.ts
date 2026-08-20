import { describe, expect, it } from "vitest";
import { parseAnswerSpec, type AnswerSpecQuestion } from "../lib/answer-spec";

const singleQ: AnswerSpecQuestion[] = [
	{
		question: "用哪个方案？",
		options: [
			{ label: "A" },
			{ label: "B" },
		],
	},
];

// 3 题混合问卷：单选 + 多选 + 单选（末题可作自定义）
const mixed3Q: AnswerSpecQuestion[] = [
	{ question: "用哪个库？", options: [{ label: "libA" }, { label: "libB" }, { label: "libC" }] },
	{ question: "启用哪些功能？", multiSelect: true, options: [{ label: "x" }, { label: "y" }, { label: "z" }] },
	{ question: "端口？", options: [{ label: "80" }, { label: "443" }] },
];

describe("parseAnswerSpec", () => {
	it("3 题混合（单选|多选|自定义）全形态", () => {
		const r = parseAnswerSpec("2,1|3,=8080", mixed3Q);
		expect(r).toEqual([
			{ questionIndex: 0, question: "用哪个库？", kind: "option", answer: "libB" },
			{ questionIndex: 1, question: "启用哪些功能？", kind: "multi", selected: ["x", "z"], answer: null },
			{ questionIndex: 2, question: "端口？", kind: "custom", answer: "8080" },
		]);
	});

	it("多选题单选一个也合法", () => {
		const r = parseAnswerSpec("1,2,2", mixed3Q);
		expect(r).toEqual([
			{ questionIndex: 0, question: "用哪个库？", kind: "option", answer: "libA" },
			{ questionIndex: 1, question: "启用哪些功能？", kind: "multi", selected: ["y"], answer: null },
			{ questionIndex: 2, question: "端口？", kind: "option", answer: "443" },
		]);
	});

	it("多选语法给单选题 → 错误具体到题", () => {
		const r = parseAnswerSpec("1|2,1|3,443", mixed3Q);
		expect(r).toContain("问题1 是单选题");
	});

	it("自定义= 可用于任意题型（选项题也可）", () => {
		const r = parseAnswerSpec("=libD,=全部,=9000", mixed3Q);
		expect(r).toEqual([
			{ questionIndex: 0, question: "用哪个库？", kind: "custom", answer: "libD" },
			{ questionIndex: 1, question: "启用哪些功能？", kind: "custom", answer: "全部" },
			{ questionIndex: 2, question: "端口？", kind: "custom", answer: "9000" },
		]);
	});

	it("文本含半角逗号 → 段数不符提示（截断引导）", () => {
		const r = parseAnswerSpec("1,1|3,=a,b", mixed3Q);
		expect(r).toContain("段数（4）与题数（3）不符");
	});

	it("题数不符（少答/多答）→ 错误", () => {
		expect(parseAnswerSpec("1,2", mixed3Q)).toContain("不符");
		expect(parseAnswerSpec("1,2,443,5", mixed3Q)).toContain("不符");
	});

	it("选项号超范围 → 错误具体到题", () => {
		const r = parseAnswerSpec("1,9,443", mixed3Q);
		expect(r).toBe("问题2 编号 9 无效，共 3 个选项");
	});

	it("非数字非=段 → 无法识别提示", () => {
		const r = parseAnswerSpec("1,abc,443", mixed3Q);
		expect(r).toContain("问题2");
		expect(r).toContain("无法识别");
	});

	it("单题旧语法兼容（纯数字）", () => {
		const r = parseAnswerSpec("2", singleQ);
		expect(r).toEqual([
			{ questionIndex: 0, question: "用哪个方案？", kind: "option", answer: "B" },
		]);
	});

	it("= 空文本 → 错误", () => {
		const r = parseAnswerSpec("=", singleQ);
		expect(r).toContain("自定义答案为空");
	});
});
