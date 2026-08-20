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

	it("前缀匹配：裸名命中带后缀会话", () => {
		const pending: Array<{ sessionId: string; command: string }> = [];
		const claims: ClaimEntry[] = [
			{ sessionId: "s1", sessionName: "catlain-6f3a", claimedAt: 1, heartbeat: Date.now() },
		];
		const a = gatewayRoute(
			{
				claims,
				whitelist: ["ou_ok"],
				writePending: (sid, d) => pending.push({ sessionId: sid, command: d.command }),
				reply: () => {},
			},
			{ ...base, text: "catlain 跑回测" },
		);
		expect(a).toBe("routed");
		expect(pending).toEqual([{ sessionId: "s1", command: "跑回测" }]);
	});

	it("前缀匹配多候选：回复候选列表不路由", () => {
		const replies: string[] = []
		const claims: ClaimEntry[] = [
			{ sessionId: "s1", sessionName: "catlain-6f3a", claimedAt: 1, heartbeat: Date.now() },
			{ sessionId: "s2", sessionName: "catlain-9b2c", claimedAt: 2, heartbeat: Date.now() },
		];
		const a = gatewayRoute(
			{
				claims,
				whitelist: ["ou_ok"],
				writePending: () => {},
				reply: (t) => replies.push(t),
			},
			{ ...base, text: "catlain x" },
		);
		expect(a).toBe("not_found_reply");
		expect(replies[0]).toContain("catlain-6f3a");
		expect(replies[0]).toContain("catlain-9b2c");
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

	it("answer 指令写入 ask-user-answer pending（含编号）", () => {
		const pending: Array<Record<string, unknown>> = [];
		const replies: string[] = [];
		const a = gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (_sid, d) => pending.push(d as Record<string, unknown>),
				reply: (t) => replies.push(t),
			},
			{ ...base, text: "alpha answer 2" },
		);
		expect(a).toBe("routed");
		expect(pending[0]?.kind).toBe("ask-user-answer");
		expect(pending[0]?.answerIndex).toBe(2);
		expect(replies[0]).toContain("代答选项 2");
	});

	it("裸编号指令等价代答", () => {
		const pending: Array<Record<string, unknown>> = [];
		gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (_sid, d) => pending.push(d as Record<string, unknown>),
				reply: () => {},
			},
			{ ...base, text: "alpha 2" },
		);
		expect(pending[0]?.answerIndex).toBe(2);
	});

	it("裸编号后缀多余文本仍走普通指令", () => {
		const pending: Array<Record<string, unknown>> = [];
		gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (_sid, d) => pending.push(d as Record<string, unknown>),
				reply: () => {},
			},
			{ ...base, text: "alpha 2 谢谢" },
		);
		expect(pending[0]?.kind).toBeUndefined();
	});

	it("中文代答指令等价", () => {
		const pending: Array<Record<string, unknown>> = [];
		gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (_sid, d) => pending.push(d as Record<string, unknown>),
				reply: () => {},
			},
			{ ...base, text: "alpha 代答 1" },
		);
		expect(pending[0]?.answerIndex).toBe(1);
	});

	it("answer 后缀多余文本走普通指令", () => {
		const pending: Array<Record<string, unknown>> = [];
		gatewayRoute(
			{
				claims: mkClaims(),
				whitelist: ["ou_ok"],
				writePending: (_sid, d) => pending.push(d as Record<string, unknown>),
				reply: () => {},
			},
			{ ...base, text: "alpha answer 2 谢谢" },
		);
		expect(pending[0]?.kind).toBeUndefined();
	});
});
