/**
 * 网关进程入口 — 全机器唯一飞书 WS 客户端（pi-feishu-gateway）
 *
 * 无 LLM、无会话。职责：入站解析、@bot 检测、白名单校验、
 * 会话名路由（claim 心跳判活）、list 仲裁、错误回报、pending 分发、
 * 空闲自退（10 分钟无存活心跳）。
 *
 * 运行：`pi-feishu-gateway`（npm bin）或会话扩展 `/feishu-gateway on` 派生。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getFeishuConfig } from "../config";
import { getCredentials } from "../credentials";
import {
	readClaims,
	CLAIM_PATH,
	isAlive,
	GATEWAY_LOG_PATH,
	GATEWAY_LOCK_PATH,
} from "../claim";
import { writePending as writePendingFile } from "../pending";
import { parseInboundEvent } from "../events";
import { gatewayRoute } from "./route";
import {
	writeLock,
	clearLock,
	initIdleState,
	tickIdle,
} from "./lifecycle";
import type { FeishuMessageEvent } from "../types";

const SCAN_INTERVAL_MS = 30_000;

// ── 日志：gateway.log，启动截断 ──
fs.mkdirSync(path.dirname(GATEWAY_LOG_PATH), { recursive: true });
const logStream = fs.createWriteStream(GATEWAY_LOG_PATH, { flags: "w" });
function log(msg: string): void {
	const line = `[${new Date().toISOString()}] ${msg}`;
	logStream.write(line + "\n");
}

async function main(): Promise<void> {
	const config = getFeishuConfig(os.homedir());
	const credentials = getCredentials(config);
	if (!credentials || !config.chatId) {
		log("启动失败：缺少凭证（feishu section / FEISHU_APP_ID/SECRET）或 chatId");
		process.exit(1);
	}

	writeLock(process.pid);
	log(`pi-feishu-gateway 启动 pid=${process.pid}`);

	// ── 出站 REST Client（回执/报错用） ──
	const sdk = await import("@larksuiteoapi/node-sdk");
	const client = new sdk.Client({
		appId: credentials.appId,
		appSecret: credentials.appSecret,
	});

	async function reply(text: string): Promise<void> {
		try {
			await client.im.message.create({
				data: {
					receive_id: config.chatId,
					content: JSON.stringify({ text }),
					msg_type: "text",
				},
				params: { receive_id_type: "chat_id" },
			});
		} catch (err) {
			log(`群回复失败: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	// ── bot open_id（@bot 检测） ──
	let botOpenId: string | null = null;
	async function fetchBotOpenId(): Promise<string | null> {
		try {
			const res = (await client.request({
				url: "/open-apis/bot/v3/info",
				method: "GET",
			} as never)) as { bot?: { open_id?: string } };
			return res?.bot?.open_id ?? null;
		} catch {
			return null;
		}
	}
	botOpenId = await fetchBotOpenId();
	log(botOpenId ? `bot open_id: ${botOpenId}` : "⚠️ 无法获取 bot open_id（入站将不可用，重试中）");

	// ── 入站处理 ──
	function onEvent(data: FeishuMessageEvent): void {
		if (!botOpenId) {
			void fetchBotOpenId().then((id) => {
				if (id) botOpenId = id;
			});
			return;
		}
		const parsed = parseInboundEvent(data, botOpenId);
		if (parsed.chatId !== config.chatId) return;
		const liveClaims = (readClaims()[config.chatId] ?? []).filter((e) =>
			isAlive(e),
		);
		const action = gatewayRoute(
			{
				claims: liveClaims,
				whitelist: config.whitelist,
				writePending: (sessionId, data2) => writePendingFile(sessionId, data2),
				reply: (text) => void reply(text),
			},
			parsed,
		);
		if (action !== "ignored") log(`路由 ${action}: "${parsed.text.slice(0, 50)}"`);
	}

	// ── 唯一 WS 连接 ──
	const dispatcher = new sdk.EventDispatcher({}).register({
		"im.message.receive_v1": async (data: unknown) => {
			try {
				onEvent(data as FeishuMessageEvent);
			} catch (err) {
				log(`入站处理异常: ${err instanceof Error ? err.message : String(err)}`);
			}
		},
	});
	const ws = new sdk.WSClient({
		appId: credentials.appId,
		appSecret: credentials.appSecret,
	});
	await ws.start({
		eventDispatcher: dispatcher as unknown as import("@larksuiteoapi/node-sdk").EventDispatcher,
	} as never);
	log("WS 长连接已建立（全机器唯一客户端）");

	// ── 空闲自退扫描 ──
	const idle = initIdleState();
	const timer = setInterval(() => {
		try {
			const claims = readClaims();
			const anyAlive = Object.values(claims)
				.flat()
				.some((e) => isAlive(e));
			if (tickIdle(idle, anyAlive)) {
				log("所有会话离线超过 10 分钟，自退");
				clearInterval(timer);
				void reply("[pi] 所有会话离线，网关关闭").finally(() => {
					clearLock();
					logStream.end();
					process.exit(0);
				});
			}
		} catch (err) {
			log(`心跳扫描异常: ${err instanceof Error ? err.message : String(err)}`);
		}
	}, SCAN_INTERVAL_MS);
}

process.on("uncaughtException", (err) => {
	log(`uncaught: ${err.stack ?? err.message}`);
});

main().catch((err) => {
	log(`启动异常退出: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
	clearLock();
	process.exit(1);
});
