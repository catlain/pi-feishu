/**
 * claim.json 仲裁 — 以 chat_id 为 key 的会话认领文件
 * 原子写入 = tmp + rename（roadmap store.ts 同款模式）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ClaimEntry, ClaimFile } from "./types";

export const CLAIM_DIR = path.join(os.homedir(), ".pi", "agent", "feishu-bridge");
export const CLAIM_PATH = path.join(CLAIM_DIR, "claim.json");

export function readClaims(filePath = CLAIM_PATH): ClaimFile {
	try {
		const raw = fs.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw) as ClaimFile;
		if (data && typeof data === "object") return data;
	} catch {
		// 不存在或损坏 → 视为空
	}
	return {};
}

export function writeClaims(claims: ClaimFile, filePath = CLAIM_PATH): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(claims, null, 2) + "\n", "utf-8");
	fs.renameSync(tmpPath, filePath);
}

/** 某群的 claim 列表 */
export function getChatClaims(chatId: string, filePath = CLAIM_PATH): ClaimEntry[] {
	return readClaims(filePath)[chatId] ?? [];
}

/** 注册 claim（同 sessionId 已存在时替换，claimedAt 保留原值不变则由调用方决定） */
export function addClaim(
	chatId: string,
	entry: ClaimEntry,
	filePath = CLAIM_PATH,
): void {
	const claims = readClaims(filePath);
	const list = claims[chatId] ?? [];
	const idx = list.findIndex((e) => e.sessionId === entry.sessionId);
	if (idx >= 0) list[idx] = entry;
	else list.push(entry);
	claims[chatId] = list;
	writeClaims(claims, filePath);
}

/** 移除 claim，返回是否移除成功 */
export function removeClaim(
	chatId: string,
	sessionId: string,
	filePath = CLAIM_PATH,
): boolean {
	const claims = readClaims(filePath);
	const list = claims[chatId];
	if (!list) return false;
	const idx = list.findIndex((e) => e.sessionId === sessionId);
	if (idx < 0) return false;
	list.splice(idx, 1);
	if (list.length === 0) delete claims[chatId];
	else claims[chatId] = list;
	writeClaims(claims, filePath);
	return true;
}

/** 按 sessionId 查找 claim（跨群） */
export function findClaimBySession(
	sessionId: string,
	filePath = CLAIM_PATH,
): { chatId: string; entry: ClaimEntry } | null {
	const claims = readClaims(filePath);
	for (const [chatId, list] of Object.entries(claims)) {
		const entry = list.find((e) => e.sessionId === sessionId);
		if (entry) return { chatId, entry };
	}
	return null;
}

/** 主会话仲裁：claim 数组中最早 claim 且存活的（isAlive 由调用方提供） */
export function pickPrimarySession(
	chatId: string,
	isAlive: (sessionId: string) => boolean,
	filePath = CLAIM_PATH,
): ClaimEntry | null {
	const list = getChatClaims(chatId, filePath)
		.filter((e) => isAlive(e.sessionId))
		.sort((a, b) => a.claimedAt - b.claimedAt);
	return list[0] ?? null;
}

/** 名字匹配的存活会话 */
export function findByName(
	chatId: string,
	name: string,
	isAlive: (sessionId: string) => boolean,
	filePath = CLAIM_PATH,
): ClaimEntry | null {
	return (
		getChatClaims(chatId, filePath).find(
			(e) => e.sessionName === name && isAlive(e.sessionId),
		) ?? null
	);
}
