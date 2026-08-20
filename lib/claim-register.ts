/**
 * claim 注册（含同名竞态防护）— 从 session-follow.ts 提取
 */

import {
	addClaim,
	getChatClaims,
} from "./claim";
import { generateSessionName } from "./naming";

/** 写入后回读校验：几乎同时 follow 的同名竞态让位追加后缀。
 * 返回最终占用且已写入 claim 文件的会话名。 */
export function registerClaim(
	chatId: string,
	selfSessionId: string,
	desired: string,
): string {
	const register = (name: string): string => {
		const taken = getChatClaims(chatId)
			.filter((e) => e.sessionId !== selfSessionId)
			.map((e) => e.sessionName);
		return generateSessionName(name, taken);
	};
	let name = register(desired);
	addClaim(chatId, { sessionId: selfSessionId, sessionName: name, claimedAt: Date.now(), heartbeat: Date.now() });
	const rival = getChatClaims(chatId).find(
		(e) => e.sessionId !== selfSessionId && e.sessionName === name,
	);
	if (rival) {
		name = register(name);
		addClaim(chatId, { sessionId: selfSessionId, sessionName: name, claimedAt: Date.now(), heartbeat: Date.now() });
	}
	return name;
}
