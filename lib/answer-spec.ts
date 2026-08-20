/**
 * 答案串解析 — awr 代答语法（feishu-ask-multi-answer）
 *
 * 语法：`awr 答案1,答案2,...`（按题序逗号分隔，每题一答）
 * - 单选题：选项号，如 `2`
 * - 多选题（multiSelect）：竖线分隔选项号，如 `1|3`
 * - 自定义题（任意题型可作 custom）：`=` 开头自由文本，如 `=先把服务停了`
 * - 半角逗号是答案分隔符，自定义文本内不能含（含则截断，错误提示引导）
 */

export interface AnswerSpecQuestion {
	question?: string;
	multiSelect?: boolean;
	options?: Array<{ label: string }>;
}

export interface AnswerSpecItem {
	questionIndex: number;
	question?: string;
	kind: "option" | "custom" | "multi";
	answer?: string | null;
	selected?: string[];
}

/** 解析答案串：逐题校验题数/题型/编号范围。
 * 返回错误串（具体到题，可直接播报）或解析后的逐题答案数组。 */
export function parseAnswerSpec(
	answerSpec: string,
	questions: AnswerSpecQuestion[],
): AnswerSpecItem[] | string {
	const rawSegments = answerSpec.split(",");
	if (questions.length !== rawSegments.length) {
		return `答案段数（${rawSegments.length}）与题数（${questions.length}）不符，请按题序逗号分隔，每题一答`;
	}
	const items: AnswerSpecItem[] = [];
	for (let qi = 0; qi < rawSegments.length; qi++) {
		const seg = rawSegments[qi]!.trim();
		const q = questions[qi]!;
		// 自定义文本：任意题型均可（对齐终端 Type something. 行对所有题开放）
		if (seg.startsWith("=")) {
			const text = seg.slice(1).trim();
			if (!text) return `问题${qi + 1} 自定义答案为空（=后需接文本）`;
			items.push({ questionIndex: qi, question: q.question, kind: "custom", answer: text });
			continue;
		}
		const optCount = q.options?.length ?? 0;
		// 编号段（单选或多选）：每个 | 分隔项都必须是 1-based 选项号
		const nums = seg.split("|").map((n) => n.trim());
		const nonNumeric = nums.find((n) => !/^\d+$/.test(n));
		if (nonNumeric !== undefined) {
			return `问题${qi + 1} 答案 "${seg}" 无法识别：选项题用选项号（多选|分隔），自定义用=开头文本`;
		}
		const idxs = nums.map((n) => Number(n));
		const outOfRange = idxs.find((n) => n < 1 || n > optCount);
		if (outOfRange !== undefined) {
			return `问题${qi + 1} 编号 ${outOfRange} 无效，共 ${optCount} 个选项`;
		}
		if (q.multiSelect) {
			const labels = idxs.map((n) => q.options![n - 1]!.label);
			items.push({
				questionIndex: qi,
				question: q.question,
				kind: "multi",
				selected: labels,
				answer: null,
			});
		} else {
			if (idxs.length > 1) {
				return `问题${qi + 1} 是单选题，只需一个选项号（多选题才用 | 分隔）`;
			}
			items.push({
				questionIndex: qi,
				question: q.question,
				kind: "option",
				answer: q.options![idxs[0]! - 1]!.label,
			});
		}
	}
	return items;
}
