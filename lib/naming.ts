/**
 * 会话名生成 — cwd basename + 短随机 ID 后缀（全部会话）
 */

import * as path from "node:path";
import * as crypto from "node:crypto";

/**
 * 生成会话名：`<basename>-<4位随机ID>`（如 `catlain-6f3a`）。
 * 所有会话统一带后缀——裸名裸奔容易让用户误以为唯一，
 * 且网关路由支持前缀匹配（输 `catlain` 即命中 `catlain-6f3a`），
 * 后缀只用于消歧义，无需用户记忆。
 * 极小概率与已占用名相同时再补一段。
 */
export function generateSessionName(
	cwd: string,
	takenNames: string[],
): string {
	const base = path.basename(cwd) || "session";
	let name = `${base}-${shortId()}`;
	while (takenNames.includes(name)) {
		name = `${name}-${shortId()}`;
	}
	return name;
}

/** 4 位 base36 随机 ID（小写字母+数字） */
function shortId(): string {
	return crypto.randomBytes(4).toString("base64url").replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 4);
}
