/**
 * 会话名生成 — 默认 cwd basename、重名追加短随机 ID 后缀
 */

import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * 已占用名字集合下生成唯一名：重名追加 4 位随机后缀（如 `catlain-6f3a`）。
 * 随机后缀替代数字递增（-2/-3）：数字靠"读当前最大 N+1"生成，多会话并发
 * follow 时易重；4 位 base36 随机 = 1.6M 空间，碰撞后再补一段，实际不会重。
 * 短 ID 而非时间戳：时间戳后缀太长（`catlain-1787210502`）不便群里 @bot 输入。
 */
export function generateSessionName(
	cwd: string,
	takenNames: string[],
): string {
	const base = path.basename(cwd) || "session";
	let name = base;
	while (takenNames.includes(name)) {
		name = `${name}-${shortId()}`;
	}
	return name;
}

/** 4 位 base36 随机 ID（小写字母+数字） */
function shortId(): string {
	return crypto.randomBytes(4).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 4);
}
