/**
 * 凭证管理 — settings.json feishu section（appId/appSecret）为主，环境变量兼容兑底
 */

import type { FeishuConfig } from "./types";

export interface FeishuCredentials {
	appId: string;
	appSecret: string;
}

export function getCredentials(config?: FeishuConfig): FeishuCredentials | null {
	const appId = config?.appId || process.env.FEISHU_APP_ID || "";
	const appSecret = config?.appSecret || process.env.FEISHU_APP_SECRET || "";
	if (!appId || !appSecret) return null;
	return { appId, appSecret };
}
