/**
 * 网关进程入口 — 全机器唯一飞书 WS 客户端（pi-feishu-gateway）
 *
 * 无 LLM、无会话。职责：入站解析、@bot 检测、白名单校验、
 * 会话名路由（claim 心跳判活）、list 仲裁、错误回报、pending 分发。
 * WS 连接管理全权交 SDK（断线自愈/判活均由 SDK 内置机制负责）；
 * 网关常驻不自退（D3：退出仅由用户显式操作触发）。
 * 日志：业务日志走 gateway.log 文件流；SDK 默认 console 日志由
 * spawn 层 stdio 重定向写入同一文件（D1，单一日志流）。
 *
 * 运行：`pi-feishu-gateway`（npm bin）或会话扩展 `/feishu-gateway on` 派生。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { getFeishuConfig } from "../config";
import { getCredentials } from "../credentials";
import { GATEWAY_LOG_PATH } from "../claim";
import { initAnchors, recordAnchor } from "./anchors";
import { createInboundHandler } from "./inbound-handler";
import { startGatewayOutbox } from "./outbox-drainer";
import { exportToDoc } from "../doc";
import { readLock, writeLock, clearLock, isProcessAlive } from "./lifecycle";
import { WsKeeper } from "./ws-keeper";
import { startPoller } from "./poller";
import { MessageIdDedup, readWatermark, watermarkPath } from "./poller-core";
import { injectPolledItems } from "./poller-inject";
import { getPollIntervalSec, FEISHU_POLL_INTERVAL_DEFAULT } from "./interval-config";
import type { FeishuMessageEvent } from "../types";

// ── 日志：gateway.log（追加模式，与 spawn 层 SDK stdio 重定向同文件、单一日志流）──
fs.mkdirSync(path.dirname(GATEWAY_LOG_PATH), { recursive: true });
const logStream = fs.createWriteStream(GATEWAY_LOG_PATH, { flags: "a" });
function log(msg: string): void {
	logStream.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// 启动分隔符：追加模式下便于区分多次运行
logStream.write(`\n===== pi-feishu-gateway 启动 ${new Date().toISOString()} =====\n`);


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

	// 锦点表从 anchors.json 恢复（与 outbox 重放同批加载）
	initAnchors();

	// ── 出站 REST Client（回执/报错用） ──
	const sdk = await import("@larksuiteoapi/node-sdk");
	const client = new sdk.Client({
		appId: credentials.appId,
		appSecret: credentials.appSecret,
	});

	async function reply(text: string, anchorSessionId?: string): Promise<void> {
		try {
			const res = (await client.im.message.create({
				data: {
					receive_id: config.chatId,
					content: JSON.stringify({ text }),
					msg_type: "text",
				},
				params: { receive_id_type: "chat_id" },
			})) as { data?: { message_id?: string } };
			// 网关提示语也可作锦点（绑定目标会话）：用户引用「已转交 xxx」续聊是自然意图
			const mid = res?.data?.message_id;
			// 诊断期（T5）：出站结果留痕——区分「网关没发」vs「发了但用户没收到」；定位后可保留（一行成本）
			log(`出站回复 ok messageId=${mid ?? "?"} text="${text.slice(0, 30)}"`);
			if (anchorSessionId && mid) recordAnchor(mid, anchorSessionId);
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

	// ── 入站处理（提取到 inbound-handler.ts）──
	const inbound = createInboundHandler({
		chatId: config.chatId,
		whitelist: config.whitelist,
		botOpenId,
		reply: (text, anchorSessionId) => void reply(text, anchorSessionId),
		refetchBotOpenId: fetchBotOpenId,
		log,
	});

	// ── 唯一 WS 连接（断线自愈由 SDK 内置重连负责；只处理命令类事件，T2.1）──
	// 双键去重集合（D5）：WS 与 Poller 共用 message_id
	const dedup = new MessageIdDedup();
	const keeper = new WsKeeper(sdk, {
		credentials,
		onMessage: inbound.onMessage,
		reply: (text) => reply(text),
		log,
		filter: inbound.isCommandEvent,
		dedup,
	});
	await keeper.start();

	if (process.env.FEISHU_EXPERIMENT_NO_OUTBOUND === "1") {
		log("⚠️ 实验模式：全部出站钉死（reply 已抑制 + outbox-drainer 不启动），堆积只记日志");
	} else {
		startGatewayOutbox(
			client as never,
			config.chatId,
			{
				exportDoc: (title, text) => exportToDoc(client as never, title, text),
				log: (msg) => log(msg),
			},
		);
		log("outbox-drainer 已启动（重启重放：遗留条目将按 FIFO 补发，过期 ask-waiting 丢弃）");
	}

	// ── 拉取 Poller（入站主通道，D1）──
	const dataDir = path.dirname(GATEWAY_LOG_PATH); // ~/.pi/agent/feishu-bridge
	const wmFile = watermarkPath(dataDir);
	const wm = readWatermark(wmFile);
	log(`Poller 启动：间隔 ${getPollIntervalSec(os.homedir())}s（热生效）、水位 ${wm ? `pos=${wm.position}` : "无（首启用时间窗重叠）"}、文件 ${wmFile}`);
	const poller = startPoller({
		client: {
			request: (opts) =>
				client.request({ url: opts.url, method: opts.method, params: opts.params } as never),
		},
		chatId: config.chatId,
		dataDir,
		intervalSec: () => getPollIntervalSec(os.homedir()), // 每 tick 重读：命令修改后热生效（D4）
		onItems: (items) => {
			const id = inbound.getBotOpenId();
			if (!id) {
				throw new Error("botOpenId 未就绪（水位不推进，下轮重拉）");
			}
			injectPolledItems(items, { ...inbound.routeDeps(), botOpenId: id, chatId: config.chatId, dedup, log });
		},
		log,
	});

	log("网关常驻运行（无自退；停止用 /feishu-gateway off）");
}

process.on("uncaughtException", (err) => {
	log(`uncaught: ${err.stack ?? err.message}`);
});

main().catch((err) => {
	log(`启动异常退出: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
	clearLock();
	process.exit(1);
});
