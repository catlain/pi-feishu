import { describe, expect, it, vi } from "vitest";
import { routeInbound } from "../lib/route";
import type { ClaimEntry } from "../lib/types";

function makeDeps(overrides: Partial<Parameters<typeof routeInbound>[0]> = {}) {
	const injectSelf = vi.fn();
	const reply = vi.fn().mockResolvedValue(undefined);
	const claims: ClaimEntry[] = [
		{ sessionId: "self", sessionName: "quant", claimedAt: 100 },
		{ sessionId: "other", sessionName: "atelier", claimedAt: 50 },
	];
	return {
		deps: {
			chatId: "c1",
			liveClaims: claims,
			selfSessionId: "self",
			isPrimary: false,
			whitelist: ["ou_me"],
			injectSelf,
			reply,
			...overrides,
		} as Parameters<typeof routeInbound>[0],
		injectSelf,
		reply,
		claims,
	};
}

const OK = { mentionedBot: true, senderOpenId: "ou_me", isSelfMessage: false, text: "" };

describe("入站路由", () => {
	it("白名单内用户路由到已 follow 会话 → 注入", () => {
		const { deps, injectSelf } = makeDeps();
		const r = routeInbound(deps, { ...OK, text: "quant 跑一下回测" });
		expect(r.action).toBe("injected");
		expect(injectSelf).toHaveBeenCalledWith("跑一下回测", "ou_me");
	});

	it("非目标会话静默", () => {
		const { deps, injectSelf } = makeDeps();
		const r = routeInbound(deps, { ...OK, text: "atelier 干活" });
		expect(r.action).toBe("silent");
		expect(injectSelf).not.toHaveBeenCalled();
	});

	it("白名单外拒绝（不注入不回复）", () => {
		const { deps, injectSelf, reply } = makeDeps();
		const r = routeInbound(deps, { ...OK, senderOpenId: "ou_stranger", text: "quant hack" });
		expect(r.action).toBe("ignored");
		expect(injectSelf).not.toHaveBeenCalled();
		expect(reply).not.toHaveBeenCalled();
	});

	it("空名单默认拒绝", () => {
		const { deps, injectSelf } = makeDeps({ whitelist: [] });
		const r = routeInbound(deps, { ...OK, text: "quant x" });
		expect(r.action).toBe("ignored");
		expect(injectSelf).not.toHaveBeenCalled();
	});

	it("未 @bot 忽略", () => {
		const { deps } = makeDeps();
		expect(routeInbound(deps, { ...OK, mentionedBot: false, text: "quant x" }).action).toBe("ignored");
	});

	it("自环忽略", () => {
		const { deps } = makeDeps();
		expect(routeInbound(deps, { ...OK, isSelfMessage: true, text: "quant x" }).action).toBe("ignored");
	});

	it("目标不存在：主会话回复在线列表，非主会话静默", () => {
		const notPrimary = makeDeps();
		expect(routeInbound(notPrimary.deps, { ...OK, text: "foo 执行X" }).action).toBe("silent");

		const primary = makeDeps({ isPrimary: true });
		const r = routeInbound(primary.deps, { ...OK, text: "foo 执行X" });
		expect(r.action).toBe("not_found_reply");
		expect(primary.reply).toHaveBeenCalledWith(
			expect.stringContaining("quant"),
		);
	});

	it("list 指令：主会话仲裁回复，非主会话静默", () => {
		const silent = makeDeps();
		expect(routeInbound(silent.deps, { ...OK, text: "list" }).action).toBe("silent");
		expect(silent.reply).not.toHaveBeenCalled();

		const primary = makeDeps({ isPrimary: true });
		const r = routeInbound(primary.deps, { ...OK, text: "list" });
		expect(r.action).toBe("handled_list");
		expect(primary.reply).toHaveBeenCalledWith(expect.stringContaining("atelier"));
	});
});
