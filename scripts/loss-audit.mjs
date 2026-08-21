/**
 * 诊断脚本：拉取时间段内群消息 vs 网关日志到达记录，量化 WS 推送丢失
 *
 * 用法：
 *   node scripts/loss-audit.mjs <开始HH:MM> <结束HH:MM>          # 今天（本地时间）
 *   node scripts/loss-audit.mjs <开始HH:MM> <结束HH:MM> <YYYY-MM-DD>
 *
 * 凭据：复用网关同一环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET（或 ~/.pi/agent/settings.json feishu section）
 * 输出：每条消息 [到达✅/丢失❌] + 内容摘要 + 丢失统计
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , startArg, endArg, dateArg] = process.argv;
if (!startArg || !endArg) {
	console.error("用法: node scripts/loss-audit.mjs <开始HH:MM> <结束HH:MM> [YYYY-MM-DD]");
	process.exit(1);
}

// ── 配置（复用网关来源）──
function loadConfig() {
	// 两种来源取并集（env 优先，但缺的字段从 settings 补齐——env 分支曾漏 chatId 导致假报缺配置）
	const settings = JSON.parse(
		fs.readFileSync(path.join(os.homedir(), ".pi/agent/settings.json"), "utf-8"),
	);
	const f = settings.feishu ?? {};
	return {
		appId: process.env.FEISHU_APP_ID ?? f.appId,
		appSecret: process.env.FEISHU_APP_SECRET ?? f.appSecret,
		chatId: f.chatId,
	};
}
const cfg = loadConfig();
if (!cfg.appId || !cfg.appSecret || !cfg.chatId) {
	console.error("缺少配置（appId/appSecret/chatId）");
	process.exit(1);
}

// ── 时间窗（本地时区 → 秒）──
const day = dateArg ?? new Date().toISOString().slice(0, 10);
function toSec(hhmm) {
	const [h, m] = hhmm.split(":").map(Number);
	// 本地时间构造（脚本在本地跑）
	const d = new Date(`${day}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`);
	return Math.floor(d.getTime() / 1000);
}
const startS = toSec(startArg);
const endS = toSec(endArg);
// ⚠️ 实测坑：API 的 start_time/end_time 参数单位是秒，但返回的 create_time 是毫秒
// （文档两处都标秒，实测不一致）。窗口传秒，展示时除以1000。
console.log(`窗口: ${day} ${startArg}~${endArg}（秒 ${startS}~${endS}）\n`);

// ── token ──
const tokenRes = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
});
const tokenJson = await tokenRes.json();
if (tokenJson.code !== 0) {
	console.error("取 token 失败:", tokenJson);
	process.exit(1);
}
const token = tokenJson.tenant_access_token;

// ── 拉取窗口内全部消息（分页）──
const all = [];
let pageToken;
do {
	const url = new URL("https://open.feishu.cn/open-apis/im/v1/messages");
	url.searchParams.set("container_id_type", "chat");
	url.searchParams.set("container_id", cfg.chatId);
	url.searchParams.set("start_time", String(startS));
	url.searchParams.set("end_time", String(endS));
	url.searchParams.set("sort_type", "ByCreateTimeAsc");
	url.searchParams.set("page_size", "50");
	if (pageToken) url.searchParams.set("page_token", pageToken);
	const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
	const json = await res.json();
	if (json.code !== 0) {
		console.error("拉取失败:", json.code, json.msg);
		process.exit(1);
	}
	all.push(...(json.data?.items ?? []));
	pageToken = json.data?.page_token;
} while (pageToken);
console.log(`API 拉到 ${all.length} 条消息\n`);

// ── 网关日志：帧级到达记录（内容+秒级时间双重匹配，因为 API 的 om_* 与事件 UUID 两套 ID）──
const log = fs.readFileSync(path.join(os.homedir(), ".pi/agent/feishu-bridge/gateway.log"), "utf-8");
const seenIds = new Set(
	[...log.matchAll(/receive message, message_type: event; message_id: ([0-9a-f-]+)/g)].map((m) => m[1]),
);
// 路由日志里的内容（秒级时间窗匹配，推送到达必有路由/ignored 行）
const routedLines = [...log.matchAll(/\[2026-08-\d+T(\d{2}:\d{2}:\d{2})\.\d+Z\] 路由 \w+: "(.{0,50})"/g)].map(
	(m) => ({ time: m[1], text: m[2] }),
);

// ── 逐条对比 ──
let arrived = 0;
let lost = [];
for (const m of all) {
	// 只关心文本类用户消息（撤回/系统消息标记跳过）
	let content = "";
	try {
		const c = JSON.parse(m.body?.content ?? "{}");
		content = c.text ?? JSON.stringify(c).slice(0, 40);
	} catch {
		content = (m.body?.content ?? "").slice(0, 40);
	}
	const tag = m.body?.deleted ? "（已撤回）" : "";
	// 内容匹配（忽略 @前缀差异）：API 文本 vs 路由日志文本
	const textClean = String(content).replace(/^@\S+\s*/, "");
	const createMs = Number(m.create_time);
	const timeStr = new Date(Math.floor(createMs / 1000) * 1000).toISOString().slice(11, 19);
	const hit =
		seenIds.has(m.message_id) ||
		routedLines.some((r) => r.text.replace(/^@\S+\s*/, "").includes(textClean.slice(0, 20)) && Math.abs(timeDiff(r.time, timeStr)) <= 5);
	const time = new Date(Math.floor(createMs / 1000) * 1000).toLocaleTimeString("zh-CN", { hour12: false });
	console.log(`${time} ${hit ? "✅" : "❌"} ${String(content).slice(0, 50)}${tag} [${m.message_id}]`);
	if (hit) arrived++;
	else if (!m.body?.deleted) lost.push({ time, content, id: m.message_id });
}

function timeDiff(a, b) {
	const [ah, am, as] = a.split(":").map(Number);
	const [bh, bm, bs] = b.split(":").map(Number);
	return ah * 3600 + am * 60 + as - (bh * 3600 + bm * 60 + bs);
}

console.log(`\n──────── 统计 ────────`);
console.log(`API 总数: ${all.length} | 网关帧级到达: ${arrived} | 丢失: ${lost.length}`);
if (lost.length > 0) {
	console.log(`\n丢失明细（时间/内容）:`);
	for (const l of lost) console.log(`  ${l.time} ${String(l.content).slice(0, 40)}`);
}
