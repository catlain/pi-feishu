#!/usr/bin/env node
/**
 * T1 真机验证脚本（一次性，跑完即弃）
 * 用法：
 *   node scripts/t1-verify.mjs send        → bot 发一条锚点消息，打印 message_id
 *   node scripts/t1-verify.mjs listen      → 起 WS 监听，dump 所有 im.message.receive_v1 事件
 *
 * 验证步骤（对应 tasks.md T1.1/T1.2/T1.3）：
 *   1. 终端1: node scripts/t1-verify.mjs send        → 记下 message_id
 *   2. 终端2: node scripts/t1-verify.mjs listen
 *   3. 群里对该消息「引用回复」一段文本（不 @bot）→ 看 listen 输出
 *   4. 再对 bot 的另一条消息引用回复（嵌套）→ 看 parent_id/root_id
 */

import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sdk = require("@larksuiteoapi/node-sdk");

// 凭证：settings.json feishu section 优先，环境变量兑底
const settingsPath = join(homedir(), ".pi", "agent", "settings.json");
let appId = process.env.FEISHU_APP_ID || "";
let appSecret = process.env.FEISHU_APP_SECRET || "";
let chatId = process.env.FEISHU_CHAT_ID || "";
try {
	const s = JSON.parse(readFileSync(settingsPath, "utf8"));
	appId = appId || s.feishu?.appId || "";
	appSecret = appSecret || s.feishu?.appSecret || "";
	chatId = chatId || s.feishu?.chatId || "";
} catch (e) {
	console.error("settings.json 读取失败:", e.message);
}
if (!appId || !appSecret || !chatId) {
	console.error("缺少 appId/appSecret/chatId（settings.json feishu section 或环境变量）");
	process.exit(1);
}

const client = new sdk.Client({ appId, appSecret });
const mode = process.argv[2];

if (mode === "send") {
	const text = process.argv[3] || `[t1-verify ${new Date().toLocaleTimeString()}] 这是锚点测试消息，请引用回复我`;
	const res = await client.im.message.create({
		data: { receive_id: chatId, content: JSON.stringify({ text }), msg_type: "text" },
		params: { receive_id_type: "chat_id" },
	});
	console.log("== 发送结果 ==");
	console.log(JSON.stringify(res, null, 2));
	console.log("\n>> message_id =", res?.data?.message_id);
	console.log(">> 现在跑: node scripts/t1-verify.mjs listen，然后引用回复上面那条消息（不 @bot）");
	process.exit(0);
}

if (mode === "listen") {
	const dumpFile = new URL("./t1-events.jsonl", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
	console.log("== WS 监听启动（全量 dump 事件，Ctrl+C 退出）==");
	console.log(">> 事件同时写入 t1-events.jsonl");
	const dispatcher = new sdk.EventDispatcher({}).register({
		"im.message.receive_v1": (data) => {
			const msg = data?.message ?? {};
			console.log("\n===== 收到事件 =====");
			console.log(JSON.stringify(data, null, 2));
			console.log("--- 关键字段 ---");
			console.log("message_id:", msg.message_id);
			console.log("parent_id:", msg.parent_id ?? "(无)");
			console.log("root_id:  ", msg.root_id ?? "(无)");
			console.log("chat_id:  ", msg.chat_id);
			console.log("chat_type:", msg.chat_type);
			console.log("mentions: ", JSON.stringify(msg.mentions ?? []));
			appendFileSync(dumpFile, JSON.stringify({ at: new Date().toISOString(), data }) + "\n");
		},
	});
	const ws = new sdk.WSClient({ appId, appSecret });
	await ws.start({ eventDispatcher: dispatcher, pingTimeout: 60 });
	console.log(">> 已连接，等待群事件…（注意：现有网关若在跑会互踢 WS，验证期间先停网关）");
	setInterval(() => {}, 1 << 30);
	process.on("SIGINT", () => {
		console.log("\n退出");
		process.exit(0);
	});
} else {
	console.log("用法: node scripts/t1-verify.mjs [send [文本] | listen]");
	process.exit(1);
}
