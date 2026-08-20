import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gatewayRoute } from "../lib/gateway/route";
import { initAnchors, recordAnchor, resetAnchors } from "../lib/gateway/anchors";
import type { ClaimEntry } from "../lib/types";

const dirs: string[] = [];
function newAnchorPath(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-route-anchor-"));
	dirs.push(d);
	return path.join(d, "anchors.json");
}
afterEach(() => {
	resetAnchors();
	for (const d of dirs.splice(0)) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

function mkClaims(): ClaimEntry[] {
	return [
		{ sessionId: "s1", sessionName: "alpha", claimedAt: 1, heartbeat: Date.now() },
		{ sessionId: "s2", sessionName: "beta", claimedAt: 2, heartbeat: Date.now() },
	];
}

interface RunResult {
	action: ReturnType<typeof gatewayRoute>;
	pending: Array<{ sessionId: string; command?: string; kind?: string }>;
	replies: string[];
}

function run(
	parsed: Partial<{ mentionedBot: boolean; text: string; parentId: string | null }>,
	claims: ClaimEntry[] = mkClaims(),
): RunResult {
	const pending: RunResult["pending"] = [];
	const replies: string[] = [];
	const action = gatewayRoute(
		{
			claims,
			whitelist: ["ou_ok"],
			writePending: (sessionId, data) => pending.push({ sessionId, ...data }),
			reply: (text) => replies.push(text),
		},
		{
			mentionedBot: false,
			senderOpenId: "ou_ok",
			isSelfMessage: false,
			text: "",
			...parsed,
		},
	);
	return { action, pending, replies };
}

describe("锚点路由（T3）", () => {
	it("T3.1 引用回复锚点命中且在线 → 免 @ 免名字直达 pending", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_bot_reply_1", "s1", p);
		const r = run({ parentId: "om_bot_reply_1", text: "跑一下测试" });
		expect(r.action).toBe("routed");
		expect(r.pending).toHaveLength(1);
		expect(r.pending[0]?.sessionId).toBe("s1");
		expect(r.pending[0]?.command).toBe("跑一下测试");
		expect(r.replies[0]).toContain("alpha");
	});

	it("T3.1 空文本引用回复也路由（空指令占位）", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_a", "s1", p);
		const r = run({ parentId: "om_a", text: "" });
		expect(r.action).toBe("routed");
		expect(r.pending[0]?.command).toContain("空指令");
	});

	it("T3.2 锚点命中但 claim 离线 → 网关回提示「已离线」", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_a", "s_dead", p);
		const r = run({ parentId: "om_a", text: "继续" });
		expect(r.action).toBe("not_found_reply");
		expect(r.pending).toHaveLength(0);
		expect(r.replies[0]).toContain("离线");
	});

	it("T3.3 未命中锚点的非 @bot 引用消息 → 静默忽略", () => {
		const p = newAnchorPath();
		initAnchors(p); // 空表
		const r = run({ parentId: "om_user_msg", text: "闲聊" });
		expect(r.action).toBe("ignored");
		expect(r.pending).toHaveLength(0);
		expect(r.replies).toHaveLength(0);
	});

	it("T3.3 回归：未命中锚点但 @bot → 名字路由兜底不变", () => {
		const p = newAnchorPath();
		initAnchors(p);
		const r = run({ parentId: "om_user_msg", mentionedBot: true, text: "alpha 干活" });
		expect(r.action).toBe("routed");
		expect(r.pending[0]?.sessionId).toBe("s1");
		expect(r.pending[0]?.command).toBe("干活");
	});

	it("D5 引用回复代答（awr）直达对应会话", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_q", "s2", p);
		const r = run({ parentId: "om_q", text: "awr 1" });
		expect(r.action).toBe("routed");
		expect(r.pending[0]).toMatchObject({ sessionId: "s2", kind: "ask-user-answer" });
	});

	it("白名单拒绝在锚点路径同样生效", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_a", "s1", p);
		const pending: unknown[] = [];
		const action = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_other"],
				writePending: (_sid, d) => pending.push(d),
				reply: () => {},
			},
			{
				mentionedBot: false,
				senderOpenId: "ou_ok",
				isSelfMessage: false,
				text: "hi",
				parentId: "om_a",
			},
		);
		expect(action).toBe("ignored");
		expect(pending).toHaveLength(0);
	});
});
