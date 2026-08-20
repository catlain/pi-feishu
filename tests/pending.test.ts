import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	writePending,
	consumePending,
	hasPending,
	clearPending,
	pendingPath,
} from "../lib/pending";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-pending-"));

beforeEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
	fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

const cmd = (over: Partial<Parameters<typeof writePending>[1]> = {}) => ({
	command: "跑回测",
	senderOpenId: "ou_x",
	arrivedAt: Date.now(),
	id: "id-1",
	...over,
});

describe("pending 文件队列", () => {
	it("生产/消费往返", () => {
		writePending("s1", cmd(), tmpDir);
		expect(hasPending("s1", tmpDir)).toBe(true);
		const got = consumePending("s1", Date.now(), tmpDir);
		expect(got?.command).toBe("跑回测");
		expect(got?.senderOpenId).toBe("ou_x");
		expect(hasPending("s1", tmpDir)).toBe(false);
		// 二次消费返回 null
		expect(consumePending("s1", Date.now(), tmpDir)).toBeNull();
	});

	it("原子写：无残留 tmp 文件", () => {
		writePending("s1", cmd(), tmpDir);
		expect(fs.readdirSync(tmpDir)).toEqual(["s1.json"]);
	});

	it("过期清理：>10 分钟的 pending 消费时丢弃", () => {
		const now = 1_000_000;
		writePending("s1", cmd({ arrivedAt: now - 10 * 60_000 }), tmpDir);
		// 边界：恰好 10 分钟仍有效
		expect(consumePending("s1", now, tmpDir)?.command).toBe("跑回测");

		writePending("s1", cmd({ arrivedAt: now - 10 * 60_001 }), tmpDir);
		expect(consumePending("s1", now, tmpDir)).toBeNull();
	});

	it("并发不重复消费（存在即删）", () => {
		writePending("s1", cmd(), tmpDir);
		// 模拟并发：读到 raw 后另一进程已删除，仍只消费一次
		const p = pendingPath("s1", tmpDir);
		const raw = fs.readFileSync(p, "utf-8");
		fs.unlinkSync(p);
		expect(fs.existsSync(p)).toBe(false);
		const second = JSON.parse(raw);
		expect(second.command).toBe("跑回测"); // raw 可读，但文件已删，无法再消费
		expect(consumePending("s1", Date.now(), tmpDir)).toBeNull();
	});

	it("clearPending 清理遗留文件", () => {
		writePending("s1", cmd({ arrivedAt: 0 }), tmpDir);
		clearPending("s1", tmpDir);
		expect(hasPending("s1", tmpDir)).toBe(false);
		// 不存在时不抛错
		clearPending("sX", tmpDir);
	});

	it("损坏文件消费丢弃", () => {
		fs.writeFileSync(pendingPath("s1", tmpDir), "{bad", "utf-8");
		expect(consumePending("s1", Date.now(), tmpDir)).toBeNull();
	});
});
