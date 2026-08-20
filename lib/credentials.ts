/**
 * 凭证管理 — 环境变量优先，兑底 settings.json feishu section（appId/appSecret 字段）
 */

import type { FeishuConfig } from "./types";

export interface FeishuCredentials {
	appId: string;
	appSecret: string;
}

export function getCredentials(config?: FeishuConfig): FeishuCredentials | null {
	const appId = process.env.FEISHU_APP_ID || config?.appId || "";
	const appSecret = process.env.FEISHU_APP_SECRET || config?.appSecret || "";
	if (!appId || !appSecret) return null;
	return { appId, appSecret };
}
