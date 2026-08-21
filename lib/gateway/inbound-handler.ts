/**
 * 网关入站处理闭包工厂（从 main.ts 提取）— WS 命令处理 + 分流判定 + 路由依赖组装
 * botOpenId 延迟就绪重试、观测日志均在此；poller-inject 复用 routeDeps。
 */

import { readClaims, isAlive } from "../claim";
import { writePending as writePendingFile } from "../pending";
import { parseInboundEvent, isWhitelisted } from "../events";
import { gatewayRoute, resolveRoute, type GatewayRouteDeps } from "./route";
import type { FeishuMessageEvent, ClaimEntry } from "../types";
import type { PendingCommand } from "../pending";

export interface InboundDeps {
	chatId: string;
	whitelist: string[];
	botOpenId: string | null;
	reply: (text: string, anchorSessionId?: string) => void;
	/** bot open_id 异步重取（未就绪时触发） */
	refetchBotOpenId: () => Promise<string | null>;
	log: (msg: string) => void;
}

export interface InboundHandler {
	onMessage: (data: unknown) => void;
	/** WS 分流判定（T2.1/T2.2）：命令类实时、消息类丢弃等拉取 */
	isCommandEvent: (data: unknown) => boolean;
	/** 组装路由依赖（每次调用重读 claims 判活） */
	routeDeps: () => GatewayRouteDeps;
	/** 当前 botOpenId（poller 注入用） */
	getBotOpenId: () => string | null;
}

export function createInboundHandler(deps: InboundDeps): InboundHandler {
	let botOpenId = deps.botOpenId;
	let lastBotIdWarnAt = 0;

	function ensureBotId(): string | null {
		if (botOpenId) return botOpenId;
		if (Date.now() - lastBotIdWarnAt > 5 * 60_000) {
			lastBotIdWarnAt = Date.now();
			deps.log("⚠️ 入站丢弃：botOpenId 未就绪（获取失败重试中），期间消息不可路由");
		}
		void deps.refetchBotOpenId().then((id) => {
			if (id) botOpenId = id;
		});
		return null;
	}

	function liveClaims(): ClaimEntry[] {
		return (readClaims()[deps.chatId] ?? []).filter((e) => isAlive(e));
	}

	function routeDeps(): GatewayRouteDeps {
		return {
			claims: liveClaims(),
			whitelist: deps.whitelist,
			writePending: (sessionId: string, d: PendingCommand) => writePendingFile(sessionId, d),
			reply: deps.reply,
		};
	}

	function isCommandEvent(data: unknown): boolean {
		const id = botOpenId ? botOpenId : null;
		if (!id) return true; // botId 未就绪不拦截（交给 onMessage 的降级逻辑）
		try {
			const parsed = parseInboundEvent(data as FeishuMessageEvent, id);
			if (parsed.chatId !== deps.chatId) return false; // 其他群的消息也丢弃
			return resolveRoute(parsed, { claims: liveClaims(), whitelist: deps.whitelist }).kind === "command";
		} catch {
			return false;
		}
	}

	function onMessage(data: unknown): void {
		const id = ensureBotId();
		if (!id) return;
		const parsed = parseInboundEvent(data as FeishuMessageEvent, id);
		if (parsed.chatId !== deps.chatId) {
			deps.log(`入站丢弃：chatId 不匹配 event=${parsed.chatId} config=${deps.chatId}`);
			return;
		}
		const action = gatewayRoute(routeDeps(), parsed);
		if (action !== "ignored") {
			const delay = parsed.eventTimeMs ? Date.now() - parsed.eventTimeMs : null;
			const delayText =
				delay === null ? "（无事件时间戳）" : `（事件延迟 ${(delay / 1000).toFixed(1)}s）`;
			deps.log(`路由 ${action}: "${parsed.text.slice(0, 50)}"` + delayText);
		} else {
			// 观测盲区修复：ignored 也留痕并区分原因，区分「没到达」vs「到达被忽略」
			let reason = "非 @bot 消息";
			if (parsed.parentId) reason = "引用回复锦点未命中（引用的不是 bot 会话消息，且未 @bot）";
			else if (parsed.mentionedBot && !isWhitelisted(parsed.senderOpenId, deps.whitelist))
				reason = "@bot 但发送者不在白名单";
			deps.log(
				`路由 ignored（${reason}）: "${parsed.text.slice(0, 50)}" parentId=${parsed.parentId ?? "-"}`,
			);
		}
	}

	return { onMessage, isCommandEvent, routeDeps, getBotOpenId: () => botOpenId };
}
