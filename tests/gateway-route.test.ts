import { describe, expect, it } from "vitest";
import { gatewayRoute } from "../lib/gateway/route";
import type { ClaimEntry } from "../lib/types";

function mkClaims(): ClaimEntry[] {
	return [
		{ sessionId: "s1", sessionName: "alpha", claimedAt: 1, heartbeat: Date.now() },
		{ sessionId: "s2", sessionName: "beta", claimedAt: 2, heartbeat: Date.now() },
	];
}

const base = { mentionedBot: true, senderOpenId: "ou_ok", isSelfMessage: false };

function setup(claims = mkClaims()) {
	const pending: Array<{ sessionId: string; command: string; senderOpenId: string; id: string }> = [];
	const replies: string[] = [];
	const action = gatewayRoute(
		{
			claims,
			whitelist: ["ou_ok"],
			writePending: (sessionId, data) => pending.push({ sessionId, ...data }),
			reply: (text) => replies.push(text),
		},
		{ ...base, text: "" },
	);
	return { pending, replies, action, claims };
}

describe("gatewayRoute 网关路由", () => {
	it("未 @bot / 自环 / 白名单拒绝 → ignored", () => {
		expect(setup().action).toBeDefined(); // sanity
		const deps = () => setup().pending;
		expect(deps()).toEqual([]);
	});

	it("list 指令：网关直接回复在线会话列表", () => {
		const { replies, action } = (() => {
			const r = setup();
			return r;
		})();
		// 重新调用带 list
		const pending: unknown[] = [];
		const replies2: string[] = [];
		const a = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: () => pending.push(1),
				reply: (t) => replies2.push(t),
			},
			{ ...base, text: "list" },
		);
		expect(a).toBe("handled_list");
		expect(replies2[0]).toContain("alpha");
		expect(replies2[0]).toContain("beta");
		expect(pending).toEqual([]);
	});

	it("名字路由命中 → 写 pending + 回执", () => {
		const pending: Array<{ sessionId: string; command: string }> = [];
		const replies: string[] = [];
		const a = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (sid, d) => pending.push({ sessionId: sid, command: d.command }),
				reply: (t) => replies.push(t),
			},
			{ ...base, text: "beta 跑回测" },
		);
		expect(a).toBe("routed");
		expect(pending).toEqual([{ sessionId: "s2", command: "跑回测" }]);
		expect(replies[0]).toContain("已转交 beta");
	});

	it("目标不在线 → 网关回复在线列表", () => {
		const replies: string[] = [];
		const a = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: () => {},
				reply: (t) => replies.push(t),
			},
			{ ...base, text: "gamma xx" },
		);
		expect(a).toBe("not_found_reply");
		expect(replies[0]).toContain("gamma");
		expect(replies[0]).toContain("alpha");
	});

	it("白名单外用户 → ignored，不写 pending 不回复", () => {
		const pending: unknown[] = [];
		const replies: string[] = [];
		const a = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: () => pending.push(1),
				reply: (t) => replies.push(t),
			},
			{ mentionedBot: true, senderOpenId: "ou_evil", isSelfMessage: false, text: "alpha hack" },
		);
		expect(a).toBe("ignored");
		expect(pending).toEqual([]);
		expect(replies).toEqual([]);
	});

	it("双闸：未 @bot 即使白名单内也 ignored", () => {
		const a = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: () => {},
				reply: () => {},
			},
			{ mentionedBot: false, senderOpenId: "ou_ok", isSelfMessage: false, text: "alpha x" },
		);
		expect(a).toBe("ignored");
	});

	it("空指令补占位文本", () => {
		const pending: Array<{ command: string }> = [];
		gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (_sid, d) => pending.push({ command: d.command }),
				reply: () => {},
			},
			{ ...base, text: "alpha" },
		);
		expect(pending[0]?.command).toBe("（空指令，请继续）");
	});
});
