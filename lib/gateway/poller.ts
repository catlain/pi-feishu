/**
 * 拉取 Poller 运行时主体（feishu-poll-primary D1）— 定时时间窗拉取 + 分页 + 回调注入。
 * 纯函数核心（水位/过滤/合并/去重）见 poller-core.ts。
 */

import type { PolledMessageItem } from "../events";
import {
	readWatermark,
	writeWatermark,
	watermarkPath,
	filterByWatermark,
} from "./poller-core";

// 纯函数核心 re-export（调用方单一入口）
export {
	readWatermark,
	writeWatermark,
	watermarkPath,
	filterByWatermark,
} from "./poller-core";
export {
	groupForMerge,
	mergeTexts,
	MessageIdDedup,
} from "./poller-core";
export type {
	Watermark,
	FilteredItems,
	RouteDecisionInput,
	MergeResult,
} from "./poller-core";


// ── Poller 主体 ────────────────────────────────────────────

/** 最小 REST 客户端接口（client.request 兼容形状，便于测试注入） */
export interface PollerClient {
	request: (opts: {
		url: string;
		method: string;
		params?: Record<string, string>;
	}) => Promise<unknown>;
}

export interface PollerDeps {
	client: PollerClient;
	chatId: string;
	/** 数据目录（水位文件） */
	dataDir: string;
	/** 轮询间隔秒（10~600）；传 getter 则每 tick 重读（命令修改后热生效，D4） */
	intervalSec: number | (() => number);
	/** 时间窗回看时长（默认 10 分钟；水位缺失时作为回退重叠窗） */
	windowSec?: number;
	/** 新消息处理回调（解析后逐条回调，合并策略由调用方决定） */
	onItems: (items: PolledMessageItem[]) => void;
	log: (msg: string) => void;
	/** 测试注入时钟/停表 */
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export function startPoller(deps: PollerDeps): { stop: () => void } {
	const { client, chatId, dataDir, intervalSec } = deps;
	const wmFile = watermarkPath(dataDir);
	const windowSec = deps.windowSec ?? 600;
	const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = deps.now ?? Date.now;
	let stopped = false;

	/** 拉取一个时间窗（分页处理），返回全部消息项 */
	async function fetchWindow(startS: number, endS: number): Promise<PolledMessageItem[]> {
		const all: PolledMessageItem[] = [];
		let pageToken: string | undefined;
		do {
			const params: Record<string, string> = {
				container_id_type: "chat",
				container_id: chatId,
				start_time: String(startS),
				end_time: String(endS),
				sort_type: "ByCreateTimeAsc",
				page_size: "50",
			};
			if (pageToken) params.page_token = pageToken;
			const res = (await client.request({
				url: "/open-apis/im/v1/messages",
				method: "GET",
				params,
			})) as { data?: { items?: PolledMessageItem[]; page_token?: string } };
			all.push(...(res?.data?.items ?? []));
			pageToken = res?.data?.page_token || undefined;
		} while (pageToken && !stopped);
		return all;
	}

	async function tick(): Promise<void> {
		const wm = readWatermark(wmFile);
		// 窗口：从水位时间起回看重叠窗（容忍索引滞后），end_time 留 60s 余量（D2）
		const nowS = Math.floor(now() / 1000);
		const startS = wm
			? Math.floor(wm.createTimeMs / 1000) - 30
			: nowS - windowSec;
		const endS = nowS + 60;
		let items: PolledMessageItem[];
		try {
			items = await fetchWindow(startS, endS);
		} catch (err) {
			deps.log(`拉取失败（下轮重试）: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		const { items: fresh, newWatermark } = filterByWatermark(items, wm, now());
		if (fresh.length > 0) {
			deps.log(`拉取窗 ${startS}~${endS} 拉到 ${items.length} 条，水位过滤后 ${fresh.length} 条新消息`);
			try {
				deps.onItems(fresh);
				if (newWatermark) writeWatermark(wmFile, newWatermark); // 确认消费后才推进
			} catch (err) {
				deps.log(`消息处理异常（水位不推进，下轮重拉）: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	}

	async function loop(): Promise<void> {
		// 首轮先跑（启动即拉一次，缩短窗口期）
		while (!stopped) {
			await tick();
			if (stopped) break;
			const sec = typeof intervalSec === "function" ? intervalSec() : intervalSec;
			await sleep(sec * 1000);
		}
	}
	void loop();

	return {
		stop() {
			stopped = true;
		},
	};
}
