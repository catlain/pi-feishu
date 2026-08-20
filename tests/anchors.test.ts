import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	initAnchors,
	lookupAnchor,
	recordAnchor,
	resetAnchors,
} from "../lib/gateway/anchors";

const dirs: string[] = [];
function newAnchorPath(): string {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "feishu-anchors-"));
	dirs.push(d);
	return path.join(d, "anchors.json");
}
afterEach(() => {
	resetAnchors();
	for (const d of dirs.splice(0)) {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

describe("anchors 锚点表", () => {
	it("记录与查询", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_1", "s1", p);
		recordAnchor("om_2", "s1", p);
		recordAnchor("om_3", "s2", p);
		expect(lookupAnchor("om_1")).toBe("s1");
		expect(lookupAnchor("om_3")).toBe("s2");
		// 同 messageId 幂等覆盖
		recordAnchor("om_3", "s3", p);
		expect(lookupAnchor("om_3")).toBe("s3");
	});

	it("未初始化 / 未记录 → null（孤儿锚点无害）", () => {
		resetAnchors();
		expect(lookupAnchor("om_x")).toBeNull();
	});

	it("重启恢复：写入后重新 init 仍可命中", () => {
		const p = newAnchorPath();
		initAnchors(p);
		recordAnchor("om_1", "s1", p);
		// 模拟重启：清内存重新加载
		resetAnchors();
		expect(lookupAnchor("om_1")).toBeNull();
		initAnchors(p);
		expect(lookupAnchor("om_1")).toBe("s1");
	});

	it("损坏文件 → 空表不抛错", () => {
		const p = newAnchorPath();
		fs.writeFileSync(p, "not-json{", "utf-8");
		expect(() => initAnchors(p)).not.toThrow();
		expect(lookupAnchor("om_1")).toBeNull();
	});

	it("非法参数（空串）不记录", () => {
		const p = newAnchorPath();
		initAnchors(p);
		expect(() => recordAnchor("", "s1", p)).not.toThrow();
		expect(lookupAnchor("")).toBeNull();
	});
});
