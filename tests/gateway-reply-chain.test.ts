import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { drainSession, type DrainerDeps } from "../lib/gateway/outbox-drainer";
import { appendOutbox } from "../lib/outbox";
import { gatewayRoute } from "../lib/gateway/route";
import { initAnchors, lookupAnchor, recordAnchor, resetAnchors } from "../lib/gateway/anchors";
import type { ClaimEntry, OutboxEntry } from "../lib/types";

const dirs: string[] = [];
function newDir(prefix: string): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	dirs.push(d);
	return d;
}
afterEach(() => {
	resetAnchors();
	for (const d of dirs.splice(0)) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function mkDeps(messageId: string, anchorsPath: string): DrainerDeps {
	return {
		sendEntry: async () => ({ sent: true, messageId }),
		exportDoc: async () => null,
		recordAnchor: (mid, sid) => recordAnchor(mid, sid, anchorsPath),
		log: () => {},
	};
}

function entry(partial: Partial<OutboxEntry> = {}): OutboxEntry {
	return {
		id: `e${Math.random().toString(36).slice(2)}`,
		createdAt: Date.now(),
		kind: "reply",
		text: "t",
		expectAck: false,
		...partial,
	};
}

describe("T4.2 出站→记锚→引用回复路由 全链路", () => {
	it("fire-and-forget：发送成功记锚，引用回复该消息直达会话", async () => {
		const outboxDir = newDir("feishu-chain-out-");
		const anchorsPath = path.join(newDir("feishu-chain-anchor-"), "anchors.json");
		initAnchors(anchorsPath);

		// 1. 会话 s1 出站一条消息
		appendOutbox("s1", entry({ text: "[pi:alpha-a7f2] 任务完成" }), outboxDir);
		const sent = await drainSession("s1", mkDeps("om_chain_1", anchorsPath), outboxDir);
		expect(sent).toBe(1);
		// 2. 发送成功即锚点
		expect(lookupAnchor("om_chain_1")).toBe("s1");

		// 3. 用户引用回复 om_chain_1（不 @bot 不带名字）→ 直达 s1
		const claims: ClaimEntry[] = [
			{ sessionId: "s1", sessionName: "alpha-a7f2", claimedAt: 1, heartbeat: Date.now() },
		];
		const pending: Array<{ sessionId: string; command: string }> = [];
		const replies: string[] = [];
		const action = gatewayRoute(
			{
				claims,
				whitelist: ["ou_ok"],
				writePending: (sid, d) => pending.push({ sessionId: sid, command: d.command ?? "" }),
				reply: (t) => replies.push(t),
			},
			{
				mentionedBot: false,
				senderOpenId: "ou_ok",
				isSelfMessage: false,
				text: "继续下一步",
				parentId: "om_chain_1",
			},
		);
		expect(action).toBe("routed");
		expect(pending).toEqual([{ sessionId: "s1", command: "继续下一步" }]);
	});

	it("expectAck：发送成功同样记锚", async () => {
		const outboxDir = newDir("feishu-chain-ack-");
		const anchorsPath = path.join(newDir("feishu-chain-anchor-"), "anchors.json");
		initAnchors(anchorsPath);

		appendOutbox("s2", entry({ text: "需要回执的条目", expectAck: true }), outboxDir);
		await drainSession("s2", mkDeps("om_chain_2", anchorsPath), outboxDir);
		expect(lookupAnchor("om_chain_2")).toBe("s2");
	});

	it("发送失败不记锚", async () => {
		const outboxDir = newDir("feishu-chain-fail-");
		const anchorsPath = path.join(newDir("feishu-chain-anchor-"), "anchors.json");
		initAnchors(anchorsPath);

		const deps: DrainerDeps = {
			sendEntry: async () => ({ sent: false, error: "net down" }),
			exportDoc: async () => null,
			recordAnchor: (mid, sid) => recordAnchor(mid, sid, anchorsPath),
			log: () => {},
		};
		appendOutbox("s1", entry({ text: "x", expectAck: true }), outboxDir);
		await drainSession("s1", deps, outboxDir);
		expect(lookupAnchor("om_fail")).toBeNull();
	});
});
