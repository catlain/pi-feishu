/**
 * 轮询间隔配置（feishu-poll-primary D4）— 全局 settings.json feishu section 持久化
 * `/feishu-gateway interval <秒>` 写入，网关每次 tick 前重读（热生效 + 重启保持）。
 */

import { getEffectiveConfig, patchSettingsSectionWithBackup } from "@pi-atelier/shared-utils";

export const FEISHU_POLL_INTERVAL_DEFAULT = 60;
export const FEISHU_POLL_INTERVAL_MIN = 10;
export const FEISHU_POLL_INTERVAL_MAX = 600;

/** 校验间隔秒（10~600），非法返回错误消息 */
export function validateIntervalSec(sec: number): string | null {
	if (!Number.isFinite(sec) || sec < FEISHU_POLL_INTERVAL_MIN || sec > FEISHU_POLL_INTERVAL_MAX) {
		return `间隔必须在 ${FEISHU_POLL_INTERVAL_MIN}~${FEISHU_POLL_INTERVAL_MAX} 秒之间`;
	}
	return null;
}

/** 读当前间隔（三层合并，缺省 60） */
export function getPollIntervalSec(cwd?: string): number {
	const { config } = getEffectiveConfig<{ pollIntervalSec?: number }>(
		"feishu",
		{},
		cwd ?? process.cwd(),
	);
	const v = config?.pollIntervalSec;
	return typeof v === "number" && v >= FEISHU_POLL_INTERVAL_MIN && v <= FEISHU_POLL_INTERVAL_MAX
		? v
		: FEISHU_POLL_INTERVAL_DEFAULT;
}

/** 写间隔到全局 settings.json feishu section（patch 合并，不覆盖其他字段；带备份加锁） */
export function setPollIntervalSec(sec: number): void {
	patchSettingsSectionWithBackup("feishu", { pollIntervalSec: sec }, {});
}
