/**
 * WsKeeper 测试共享 stub — 构造带 FakeWS 的 keeper（不真连 WS）
 */

import { WsKeeper, type WsKeeperOptions } from "../../lib/gateway/ws-keeper";

export interface MkKeeperOpts {
	/** reply 群播收集 */
	replies?: string[];
	/** onMessage 入站收集 */
	messages?: unknown[];
}

/** 构造带 stub SDK 的 WsKeeper（不真连 WS） */
export function mkKeeper(opts?: MkKeeperOpts) {
	const startCalls: unknown[] = [];
	const startOpts: Array<{
		onReconnecting?: () => void;
		onReconnected?: () => void;
	}> = [];
	const dispatcherReg: Record<string, (data: unknown) => Promise<void>> = {};
	class FakeWS {
		constructor(ctorOpts: unknown) {
			startCalls.push(ctorOpts);
		}
		async start(so: unknown) {
			startOpts.push(so as never);
		}
		close() {
			/* noop */
		}
	}
	const sdk = {
		EventDispatcher: class {
			register(ev: typeof dispatcherReg) {
				Object.assign(dispatcherReg, ev);
				return this;
			}
		},
		WSClient: FakeWS,
	} as unknown as typeof import("@larksuiteoapi/node-sdk");
	const logs: string[] = [];
	const keeperOpts: WsKeeperOptions = {
		credentials: { appId: "a", appSecret: "s" },
		onMessage: (d) => opts?.messages?.push(d),
		reply: async (t) => {
			opts?.replies?.push(t);
		},
		log: (m) => logs.push(m),
	};
	const keeper = new WsKeeper(sdk, keeperOpts);
	return { keeper, keeperOpts, dispatcherReg, logs, startCalls, startOpts };
}
