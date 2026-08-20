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
