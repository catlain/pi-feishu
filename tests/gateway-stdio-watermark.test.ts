import { describe, expect, it } from "vitest";
import { createSdkLogger, noopStdio } from "../lib/gateway/stdio";
import { WsKeeper } from "../lib/gateway/ws-keeper";

// ── 1.4 stdio 隔离 ──

describe("createSdkLogger 注入", () => {
	it("四个级别均写入目标流", () => {
		const lines: string[] = [];
		const logger = createSdkLogger((line) => lines.push(line));
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toContain("sdk:debug] d");
		expect(lines[3]).toContain("sdk:error] e");
	});
});

describe("noopStdio 兜底", () => {
	it("console 写入被吞且不抛", () => {
		const stdoutWrite = process.stdout.write;
		const stderrWrite = process.stderr.write;
		try {
			noopStdio();
			expect(() => {
				console.log("hello");
				console.error("world");
				process.stdout.write("raw");
			}).not.toThrow();
		} finally {
			process.stdout.write = stdoutWrite;
			process.stderr.write = stderrWrite;
		}
	});
});

// ── 2.4 判活状态映射 ──

type FakeStatus = { state: string } | null;

describe("WsKeeper.isConnected 状态映射", () => {
	it.each(["connected", "reconnecting", "connecting"])(
		"%s 视为健康",
		(state) => {
			const keeper = new WsKeeper({} as never, {
				credentials: { appId: "a", appSecret: "b" },
				onMessage: () => {},
				reply: async () => {},
				log: () => {},
				exit: () => {},
			});
			// terminal=false、ws 已存在：直接注入私有字段模拟已启动
			(keeper as unknown as { terminal: boolean }).terminal = false;
			(keeper as unknown as { ws: unknown }).ws = {
				getConnectionStatus: () => ({ state }),
			};
			expect(keeper.isConnected(Date.now())).toBe(true);
		},
	);

	it.each(["failed", "idle"])("%s 视为不健康", (state) => {
		const keeper = new WsKeeper({} as never, {
			credentials: { appId: "a", appSecret: "b" },
			onMessage: () => {},
			reply: async () => {},
			log: () => {},
			exit: () => {},
		});
		(keeper as unknown as { ws: unknown }).ws = {
			getConnectionStatus: () => ({ state }),
		};
		expect(keeper.isConnected(Date.now())).toBe(false);
	});

	it("reconnecting（静默期）不触发重建：水位早已过期仍健康", () => {
		const keeper = new WsKeeper({} as never, {
			credentials: { appId: "a", appSecret: "b" },
			onMessage: () => {},
			reply: async () => {},
			log: () => {},
			exit: () => {},
		});
		(keeper as unknown as { terminal: boolean }).terminal = false;
		// 水位 10 分钟前更新（远超 3 分钟阈值），但状态 reconnecting → 仍健康
		(keeper as unknown as { lastEventAt: number }).lastEventAt =
			Date.now() - 10 * 60_000;
		(keeper as unknown as { ws: unknown }).ws = {
			getConnectionStatus: () => ({ state: "reconnecting" }),
		};
		expect(keeper.isConnected(Date.now())).toBe(true);
	});

	it("getConnectionStatus 不可用（旧 SDK）→ 回退水位判活", () => {
		const keeper = new WsKeeper({} as never, {
			credentials: { appId: "a", appSecret: "b" },
			onMessage: () => {},
			reply: async () => {},
			log: () => {},
			exit: () => {},
		});
		const k = keeper as unknown as {
			terminal: boolean;
			lastEventAt: number;
			ws: unknown;
		};
		k.terminal = false;
		k.ws = {}; // 无 getConnectionStatus
		k.lastEventAt = Date.now() - 1_000;
		expect(keeper.isConnected(Date.now())).toBe(true); // 水位内健康
		k.lastEventAt = Date.now() - 5 * 60_000;
		expect(keeper.isConnected(Date.now())).toBe(false); // 水位过期判死
	});
});
