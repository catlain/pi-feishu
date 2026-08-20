/**
 * 网关进程入口 — 全机器唯一飞书 WS 客户端（pi-feishu-gateway）
 *
 * 无 LLM、无会话。职责：入站解析、@bot 检测、白名单校验、
 * 会话名路由（claim 心跳判活）、list 仲裁、错误回报、pending 分发、
 * 空闲自退（10 分钟无存活心跳）。
 * WS 断线检测与自动重连见 ws-keeper.ts。
 *
 * 运行：`pi-feishu-gateway`（npm bin）或会话扩展 `/feishu-gateway on` 派生。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getFeishuConfig } from "../config";
import { getCredentials } from "../credentials";
import { readClaims, isAlive, GATEWAY_LOG_PATH } from "../claim";
import { writePending as writePendingFile } from "../pending";
import { parseInboundEvent } from "../events";
import { gatewayRoute } from "./route";
import { startGatewayOutbox } from "./outbox-drainer";
import { exportToDoc } from "../doc";
import { readLock, writeLock, clearLock, initIdleState, tickIdle, isProcessAlive } from "./lifecycle";
import { WsKeeper } from "./ws-keeper";
import { createSdkLogger, noopStdio } from "./stdio";
import type { FeishuMessageEvent } from "../types";

const SCAN_INTERVAL_MS = 30_000;

// ── 日志：gateway.log，启动截断 ──
fs.mkdirSync(path.dirname(GATEWAY_LOG_PATH), { recursive: true });
const logStream = fs.createWriteStream(GATEWAY_LOG_PATH, { flags: "w" });
function log(msg: string): void {
	logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// stdio 隔离：任何 console 写入不再触死管道（EPIPE 根治）
noopStdio();


function shutdown(code: number): void {
	logStream.end();
	process.exit(code);
}

async function main(): Promise<void> {
	const config = getFeishuConfig(os.homedir());
	const credentials = getCredentials(config);
	if (!credentials || !config.chatId) {
		log("启动失败：缺少凭证（feishu section / FEISHU_APP_ID/SECRET）或 chatId");
		process.exit(1);
	}

	// 单实例护栏：已有活网关则拒绝启动，避免双进程互踢 WS + 锁覆盖导致旧进程失联
	const lock = readLock();
	if (lock && isProcessAlive(lock.pid)) {
		log(`已有网关在运行（PID ${lock.pid}），拒绝启动`);
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
	function onMessage(data: unknown): void {
		if (!botOpenId) {
			void fetchBotOpenId().then((id) => {
				if (id) botOpenId = id;
			});
			return;
		}
		const parsed = parseInboundEvent(data as FeishuMessageEvent, botOpenId);
		if (parsed.chatId !== config.chatId) {
			log(`入站丢弃：chatId 不匹配 event=${parsed.chatId} config=${config.chatId}`);
			return;
		}
		const liveClaims = (readClaims()[config.chatId] ?? []).filter((e) =>
			isAlive(e),
		);
		const action = gatewayRoute(
			{
				claims: liveClaims,
				whitelist: config.whitelist,
				writePending: (sessionId, d) => writePendingFile(sessionId, d),
				reply: (text) => void reply(text),
			},
			parsed,
		);
		if (action !== "ignored") {
			const delay = parsed.eventTimeMs ? Date.now() - parsed.eventTimeMs : null;
			log(
				`路由 ${action}: "${parsed.text.slice(0, 50)}"` +
					(delay !== null ? `（事件延迟 ${(delay / 1000).toFixed(1)}s）` : "（无事件时间戳）"),
			);
		}
	}

	// ── 唯一 WS 连接（断线检测/重连见 ws-keeper） ──
	const keeper = new WsKeeper(sdk, {
		credentials,
		onMessage,
		reply,
		log,
		exit: (code) => shutdown(code),
		// SDK logger 注入文件流，SDK 日志不再写 console
		logger: createSdkLogger((line) => logStream.write(`${line}\n`)),
	});
	await keeper.start();
	keeper.startReconnectLoop(() => shutdown(1));

	startGatewayOutbox(
		client as never,
		config.chatId,
		{
			exportDoc: (title, text) => exportToDoc(client as never, title, text),
			log: (msg) => log(msg),
		},
	);
	log("outbox-drainer 已启动（重启重放：遗留条目将按 FIFO 补发，过期 ask-waiting 丢弃）");

	// ── 空闲自退扫描 ──
	const idle = initIdleState();
	const timer = setInterval(() => {
		try {
			const claims = readClaims();
			const anyAlive = Object.values(claims).flat().some((e) => isAlive(e));
			if (keeper.connectedOnce() && tickIdle(idle, anyAlive)) {
				log("所有会话离线超过 10 分钟，自退");
				clearInterval(timer);
				keeper.stop();
				void reply("[pi] 所有会话离线，网关关闭").finally(() => {
					clearLock();
					shutdown(0);
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
