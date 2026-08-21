/**
 * anchors — 引用回复锚点表（messageId → sessionId 多对一映射）
 *
 * 设计原则（design.md D1/D2）：
 * - 每条出站即锚点：drainer 发送成功后追加，无「建头」动作
 * - 判活与归属分离：anchors 永久追加管「消息归属」；claim 表 60s TTL 管「谁在线可路由」
 *   两套生命周期不对称是有意设计
 * - 网关单写（依赖 feishu-gateway-full-duplex 单写者前提），读侧无锁
 * - 原子写入 = tmp + rename（claim.ts 同款模式）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CLAIM_DIR } from "../claim";

export const ANCHORS_PATH = path.join(CLAIM_DIR, "anchors.json");

/** 内存表（启动时从 anchors.json 恢复）；值为 [sessionId, recordedAt] */
let table = new Map<string, [string, number]>();

/** 条目：messageId → { sessionId, recordedAt } */
interface AnchorFile {
	[messageId: string]: { sessionId: string; recordedAt: number };
}

/** 从 anchors.json 恢复内存表（幂等，网关启动时调用一次） */
export function initAnchors(filePath = ANCHORS_PATH): void {
	table = new Map();
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw) as AnchorFile;
		if (data && typeof data === "object") {
			for (const [mid, v] of Object.entries(data)) {
				if (v && typeof v.sessionId === "string") {
					// 保留原始记录时间（旧 bug：全量重写刷掉 recordedAt，丢失取证能力）
					table.set(mid, [v.sessionId, typeof v.recordedAt === "number" ? v.recordedAt : 0]);
				}
			}
		}
	} catch {
		// 不存在或损坏 → 空表
	}
}

/** 追加锚点：messageId → sessionId（同一 messageId 重复记录幂等覆盖） */
export function recordAnchor(
	messageId: string,
	sessionId: string,
	filePath = ANCHORS_PATH,
): void {
	if (!messageId || !sessionId) return;
	table.set(messageId, [sessionId, Date.now()]);
	persist(filePath);
}

/** 查询锚点：返回 sessionId，未命中返回 null（孤儿锚点无害，判活由调用方联合 claim 完成） */
export function lookupAnchor(messageId: string): string | null {
	return table.get(messageId)?.[0] ?? null;
}

/** 持久化到文件（tmp + rename 原子写；保留各条原始 recordedAt，不全量刷新） */
function persist(filePath: string): void {
	const data: AnchorFile = {};
	for (const [mid, [sid, at]] of table) {
		data[mid] = { sessionId: sid, recordedAt: at };
	}
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
	fs.renameSync(tmpPath, filePath);
}

/** 测试用：清空内存表 */
export function resetAnchors(): void {
	table = new Map();
}
