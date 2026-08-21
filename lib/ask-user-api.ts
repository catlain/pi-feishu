/**
 * fork 包 @pi-atelier/rpiv-ask-user（v3）程序化代答 API 的访问入口。
 *
 * v3 起包仅导出命名函数（submitAskUserAnswer / getActiveAskParams /
 * hasActiveAsk），不再有 globalThis API 对象——跨实例一致性由包内共享同一
 * symbol 槽位保证，命名导出只是访问入口，天然规避 first-loader-wins。
 *
 * 依赖容错：包未安装或导出不完整时 askUserApi() 返回 null，调用方按
 * 「问卷已过期」播报，不抛错。每次调用都动态 import——模块实例由模块
 * 系统缓存，无重复解析开销，也便于测试 vi.mock 拦截。
 */

import type { AnswerSpecItem, AnswerSpecQuestion } from "./answer-spec";

/** fork 包代答 API 的结构视图（不直接依赖包类型，保持依赖可选） */
export interface AskUserApi {
	getActiveAskParams: () => { questions?: AnswerSpecQuestion[] } | null;
	submitAskUserAnswer: (r: { answers: AnswerSpecItem[]; cancelled: boolean }) => boolean;
}

/** 解析 fork 包 API；依赖缺失 / 导出不完整 → null（不抛）
 * 包名经变量传给 import()：tsc 不静态拉入包的 .ts 源码（其 peer 型 i18n /
 * SDK 版本与本地 typecheck 环境不完全一致），运行时由 jiti 从 node_modules
 * 解析真实包；vitest 下 vi.mock 同样拦截（已实验验证）。 */
export async function askUserApi(): Promise<AskUserApi | null> {
	try {
		const pkg = "@pi-atelier/rpiv-ask-user";
		const mod = (await import(/* @vite-ignore */ pkg)) as Partial<AskUserApi>;
		if (
			typeof mod.getActiveAskParams !== "function" ||
			typeof mod.submitAskUserAnswer !== "function"
		) {
			return null;
		}
		return {
			getActiveAskParams: mod.getActiveAskParams.bind(mod),
			submitAskUserAnswer: mod.submitAskUserAnswer.bind(mod),
		};
	} catch {
		return null;
	}
}
