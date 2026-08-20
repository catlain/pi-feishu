/**
 * 凭证管理 — 环境变量读取，缺失时静默降级
 */

export interface FeishuCredentials {
	appId: string;
	appSecret: string;
}

export function getCredentials(): FeishuCredentials | null {
	const appId = process.env.FEISHU_APP_ID;
	const appSecret = process.env.FEISHU_APP_SECRET;
	if (!appId || !appSecret) return null;
	return { appId, appSecret };
}
