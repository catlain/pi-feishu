/**
 * pending 文件队列 — 网关 → 会话的指令分发
 * 目录：~/.pi/agent/feishu-bridge/pending/<sessionId>.json
 * 原子写 tmp+rename；消费 = 读+删；>10 分钟的遗留 pending 视为过期。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PENDING_DIR } from "./claim";

export const PENDING_TTL_MS = 10 * 60_000;

export interface PendingCommand {
	/** 指令内容（会话名已剥去） */
	command: string;
	/** 发送者 open_id */
	senderOpenId: string;
	/** 网关收到时间戳 */
	arrivedAt: number;
	/** 唯一 id（消费幂等用） */
	id: string;
	/** 指令种类：普通注入文本 / ask-user 问卷代答 */
	kind?: "command" | "ask-user-answer";
	/** kind=ask-user-answer 时：选项编号（1-based，写入前已验证） */
	answerIndex?: number;
}

export function pendingPath(sessionId: string, dir = PENDING_DIR): string {
	return path.join(dir, `${sessionId}.json`);
}

/** 网关写指令（原子写） */
export function writePending(
	sessionId: string,
	data: PendingCommand,
	dir = PENDING_DIR,
): void {
	fs.mkdirSync(dir, { recursive: true });
	const p = pendingPath(sessionId, dir);
	const tmp = `${p}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
	fs.renameSync(tmp, p);
}

/** 是否存在待消费指令 */
export function hasPending(sessionId: string, dir = PENDING_DIR): boolean {
	return fs.existsSync(pendingPath(sessionId, dir));
}

/**
 * 消费指令：读 + 删（先删后返回，保证并发不重复消费）。
 * 过期（>10 分钟）的遗留 pending 直接清理、返回 null（不注入过期指令）。
 */
export function consumePending(
	sessionId: string,
	now: number = Date.now(),
	dir = PENDING_DIR,
): PendingCommand | null {
	const p = pendingPath(sessionId, dir);
	let raw: string;
	try {
		raw = fs.readFileSync(p, "utf-8");
	} catch {
		return null; // 不存在
	}
	// 读到即删：存在即删，杜绝并发双消费
	try {
		fs.unlinkSync(p);
	} catch {
		// 已被并发删除
	}
	let data: PendingCommand;
	try {
		data = JSON.parse(raw) as PendingCommand;
	} catch {
		return null; // 损坏文件丢弃
	}
	if (now - (data.arrivedAt ?? 0) > PENDING_TTL_MS) return null;
	return data;
}

/** 会话启动时清理自己的遗留 pending（无论是否过期） */
export function clearPending(sessionId: string, dir = PENDING_DIR): void {
	try {
		fs.unlinkSync(pendingPath(sessionId, dir));
	} catch {
		// 不存在即无事
	}
}
