/**
 * Poller 纯函数核心（feishu-poll-primary D2/D3/D5）
 * 水位持久化、时间窗过滤、同窗合并、双键去重集合。
 * 独立于运行时主体（poller.ts），全部可测纯函数/类。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parsePolledMessage, type PolledMessageItem } from "../events";
import type { RouteResolution } from "./route";

// ── 水位持久化（D2）────────────────────────────────────────

export interface Watermark {
	/** 已消费的最大 message_position */
	position: number;
	/** 该 position 对应消息的 create_time（ms）——水位损坏回退重叠窗的锚点 */
	createTimeMs: number;
	updatedAt: number;
}

/** 水位文件路径（默认 ~/.pi/agent/feishu-bridge/poller-watermark.json） */
export function watermarkPath(dataDir: string): string {
	return path.join(dataDir, "poller-watermark.json");
}

export function readWatermark(file: string): Watermark | null {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<Watermark>;
		if (
			typeof raw.position === "number" && Number.isFinite(raw.position) &&
			typeof raw.createTimeMs === "number" && Number.isFinite(raw.createTimeMs)
		) {
			return { position: raw.position, createTimeMs: raw.createTimeMs, updatedAt: raw.updatedAt ?? 0 };
		}
		return null;
	} catch {
		return null; // 缺失/损坏/非法 → 回退时间窗重叠
	}
}

export function writeWatermark(file: string, wm: Watermark): void {
	const tmp = `${file}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(wm));
	fs.renameSync(tmp, file);
}

// ── 拉取结果 → 待路由消息（水位过滤，可测纯函数）────────────────

export interface FilteredItems {
	/** 水位过滤后的新消息（position 升序） */
	items: PolledMessageItem[];
	/** 推进后的水位（无可消费消息时为 null） */
	newWatermark: Watermark | null;
}

/**
 * 时间窗拉取结果 → 新消息集（D2）：position > 水位 过滤；
 * 无水位的消息（旧接口缺 position）按 create_time > 水位时间 兜底。
 * 只有确认消费后才推进水位（newWatermark 在 items 非空时才产生）。
 */
export function filterByWatermark(
	items: PolledMessageItem[],
	prev: Watermark | null,
	now = Date.now(),
): FilteredItems {
	const fresh = items.filter((it) => {
		if (it.deleted) return false; // 已撤回/系统消息
		if (it.sender?.sender_type === "app") return true; // bot 自消息也要消费水位，注入侧过滤
		if (!prev) return true; // 无水位（首启/损坏回退）：时间窗重叠天然限定范围
		if (typeof it.message_position === "string" && it.message_position !== "") {
			return Number(it.message_position) > prev.position;
		}
		const createMs = it.create_time ? Number(it.create_time) : NaN;
		return Number.isFinite(createMs) && createMs > prev.createTimeMs;
	});
	fresh.sort((a, b) => {
		const pa = a.message_position ? Number(a.message_position) : 0;
		const pb = b.message_position ? Number(b.message_position) : 0;
		return pa - pb;
	});
	if (fresh.length === 0) return { items: [], newWatermark: null };
	const last = fresh[fresh.length - 1];
	const lastPos = last.message_position ? Number(last.message_position) : prev ? prev.position : 0;
	const lastMs = last.create_time ? Number(last.create_time) : now;
	return {
		items: fresh,
		newWatermark: {
			position: Math.max(lastPos, prev?.position ?? 0),
			createTimeMs: Math.max(lastMs, prev?.createTimeMs ?? 0),
			updatedAt: now,
		},
	};
}

// ── 同窗合并（D3，可测纯函数）──────────────────────────────

export interface RouteDecisionInput {
	/** 已解析入站（含 messageId/position） */
	parsed: ReturnType<typeof parsePolledMessage>;
	/** 路由判定（复用 resolveRoute，T2.2） */
	decision: RouteResolution;
}

export interface MergeResult {
	/** 命令类：逐条独立路由 */
	commands: RouteDecisionInput[];
	/** 转交型：按目标会话分组（保留完整条目，注入侧用 mergeTexts 拼接文本、awr 保留语义） */
	merged: { targetSessionId: string; entries: RouteDecisionInput[] }[];
}

/** 同窗分组：命令独立、转交合并（只分组不注入，注入格式由调用方定） */
export function groupForMerge(inputs: RouteDecisionInput[]): MergeResult {
	const commands: RouteDecisionInput[] = [];
	const byTarget = new Map<string, RouteDecisionInput[]>();
	for (const input of inputs) {
		const decision = input.decision;
		if (decision.kind === "ignored") continue;
		if (decision.kind === "command") {
			commands.push(input);
			continue;
		}
		const list = byTarget.get(decision.targetSessionId) ?? [];
		list.push(input);
		byTarget.set(decision.targetSessionId, list);
	}
	return {
		commands,
		merged: [...byTarget.entries()].map(([targetSessionId, entries]) => ({ targetSessionId, entries })),
	};
}

/** 合并文本：多条时换行拼接 + 条数标注（单条不加标注） */
export function mergeTexts(texts: string[]): string {
	if (texts.length === 1) return texts[0];
	return `[${texts.length} 条合并]\n${texts.join("\n")}`;
}

// ── 去重集合（D5：WS 与 Poller 共用 message_id，滚动环形）────

export class MessageIdDedup {
	private seen = new Set<string>();
	private ring: string[] = [];
	constructor(private capacity = 512) {}
	has(id: string): boolean { return this.seen.has(id); }
	add(id: string): void {
		if (this.seen.has(id)) return;
		this.seen.add(id);
		this.ring.push(id);
		if (this.ring.length > this.capacity) {
			const old = this.ring.shift();
			if (old) this.seen.delete(old);
		}
	}
}
