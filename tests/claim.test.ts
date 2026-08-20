import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	addClaim,
	findByName,
	findClaimBySession,
	getChatClaims,
	pickPrimarySession,
	readClaims,
	removeClaim,
	touchHeartbeat,
	isAlive,
	writeClaims,
} from "../lib/claim";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-claim-"));
const claimPath = path.join(tmpDir, "claim.json");

beforeEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("claim 读写", () => {
	it("空文件返回空对象", () => {
		expect(readClaims(claimPath)).toEqual({});
	});

	it("addClaim 后可读取", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1 }, claimPath);
		expect(getChatClaims("c1", claimPath)).toHaveLength(1);
	});

	it("addClaim 同 sessionId 替换", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1 }, claimPath);
		addClaim("c1", { sessionId: "s1", sessionName: "b", claimedAt: 2 }, claimPath);
		const list = getChatClaims("c1", claimPath);
		expect(list).toHaveLength(1);
		expect(list[0]!.sessionName).toBe("b");
	});

	it("removeClaim 移除后空数组清理 key", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1 }, claimPath);
		expect(removeClaim("c1", "s1", claimPath)).toBe(true);
		expect(readClaims(claimPath)).toEqual({});
		expect(removeClaim("c1", "s1", claimPath)).toBe(false);
	});

	it("写坏文件容错为空", () => {
		fs.writeFileSync(claimPath, "{bad json", "utf-8");
		expect(readClaims(claimPath)).toEqual({});
	});

	it("findClaimBySession 跨群查找", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1 }, claimPath);
		addClaim("c2", { sessionId: "s2", sessionName: "b", claimedAt: 2 }, claimPath);
		expect(findClaimBySession("s2", claimPath)?.chatId).toBe("c2");
		expect(findClaimBySession("s9", claimPath)).toBeNull();
	});
});

describe("claim 仲裁", () => {

	describe("心跳判活", () => {
		it("heartbeat 距今 <=60s 存活，>60s 离线（边界）", () => {
			const now = 100_000;
			expect(isAlive({ sessionId: "s", sessionName: "a", claimedAt: 0, heartbeat: now - 60_000 }, now)).toBe(true);
			expect(isAlive({ sessionId: "s", sessionName: "a", claimedAt: 0, heartbeat: now - 60_001 }, now)).toBe(false);
		});

		it("无 heartbeat 字段回退 claimedAt", () => {
			expect(isAlive({ sessionId: "s", sessionName: "a", claimedAt: Date.now() })).toBe(true);
			expect(isAlive({ sessionId: "s", sessionName: "a", claimedAt: Date.now() - 61_000 })).toBe(false);
		});
	});

	it("touchHeartbeat 原子更新单条，其他条目不变", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1, heartbeat: 100 }, claimPath);
		addClaim("c1", { sessionId: "s2", sessionName: "b", claimedAt: 2, heartbeat: 200 }, claimPath);
		expect(touchHeartbeat("c1", "s1", claimPath)).toBe(true);
		const list = getChatClaims("c1", claimPath);
		expect(list[0]!.heartbeat! > 100).toBe(true);
		expect(list[1]!.heartbeat).toBe(200);
		expect(fs.existsSync(claimPath + ".tmp")).toBe(false);
	});

	it("touchHeartbeat 会话不存在返回 false", () => {
		expect(touchHeartbeat("cX", "sX", claimPath)).toBe(false);
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1 }, claimPath);
		expect(touchHeartbeat("c1", "s9", claimPath)).toBe(false);
	});

	it("离线会话不被路由匹配（findByName 配合 isAlive）", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: Date.now() - 61_000 }, claimPath);
		addClaim("c1", { sessionId: "s2", sessionName: "b", claimedAt: 1, heartbeat: Date.now() }, claimPath);
		const alive = (id: string) => {
			const e = getChatClaims("c1", claimPath).find((x) => x.sessionId === id)!;
			return isAlive(e);
		};
		expect(findByName("c1", "a", alive, claimPath)).toBeNull();
		expect(findByName("c1", "b", alive, claimPath)?.sessionId).toBe("s2");
	});

	it("pickPrimarySession 取最早 claim 且存活", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 100 }, claimPath);
		addClaim("c1", { sessionId: "s2", sessionName: "b", claimedAt: 50 }, claimPath);
		// s1 存活、s2 死亡 → 主会话 s1
		const primary = pickPrimarySession("c1", (id) => id === "s1", claimPath);
		expect(primary?.sessionId).toBe("s1");
		// 都存活 → 最早 claim 的 s2
		const primary2 = pickPrimarySession("c1", () => true, claimPath);
		expect(primary2?.sessionId).toBe("s2");
	});

	it("findByName 只匹配存活会话", () => {
		addClaim("c1", { sessionId: "s1", sessionName: "a", claimedAt: 1 }, claimPath);
		expect(findByName("c1", "a", () => false, claimPath)).toBeNull();
		expect(findByName("c1", "a", () => true, claimPath)?.sessionId).toBe("s1");
		expect(findByName("c1", "nope", () => true, claimPath)).toBeNull();
	});
});
