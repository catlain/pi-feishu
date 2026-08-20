/**
 * 配置读取 — shared-utils 三层合并（feishu section）
 */

import { getEffectiveConfig } from "@pi-atelier/shared-utils";
import type { FeishuConfig } from "./types";

export const FEISHU_CONFIG_DEFAULTS: FeishuConfig = {
	chatId: "",
	whitelist: [],
	truncateThreshold: 2000,
};

export function getFeishuConfig(cwd?: string): FeishuConfig {
	const { config } = getEffectiveConfig<FeishuConfig>(
		"feishu",
		FEISHU_CONFIG_DEFAULTS,
		cwd ?? process.cwd(),
	);
	return {
		...FEISHU_CONFIG_DEFAULTS,
		...config,
		whitelist: Array.isArray(config.whitelist) ? config.whitelist : [],
	};
}
