/**
 * 会话名生成 — 默认 cwd basename、重名数字后缀
 */

import * as path from "node:path";

/** 已占用名字集合下生成唯一名：重名追加 -2、-3… */
export function generateSessionName(
	cwd: string,
	takenNames: string[],
): string {
	const base = path.basename(cwd) || "session";
	let name = base;
	let n = 2;
	while (takenNames.includes(name)) {
		name = `${base}-${n}`;
		n++;
	}
	return name;
}
