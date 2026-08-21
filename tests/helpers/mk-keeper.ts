/**
 * WsKeeper 测试共享 stub — 构造带 FakeWS 的 keeper（不真连 WS）
 */

import { WsKeeper, type WsKeeperOptions } from "../../lib/gateway/ws-keeper";

export type Rivals = Array<{ pid: number; cmd: string }>;

export interface MkKeeperOpts {
	/** 旧 SDK：不提供 getConnectionStatus（isConnected 回退事件水位） */
	legacySdk?: boolean;
	/** 竞争监测注入（T2 异步消费） */
	checkCompeting?: WsKeeperOptions["checkCompeting"];
	/** 服务端下发 pingInterval（毫秒）：模拟 wsConfig.getWS() */
	serverPingIntervalMs?: number;
	/** reply 群播收集 */
	replies?: string[];
}

/** 构造带 stub SDK 的 WsKeeper（不真连 WS） */
export function mkKeeper(opts?: MkKeeperOpts) {
	const startCalls: unknown[] = [];
	const startOpts: Array<{ onReconnecting?: () => void }> = [];
	const dispatcherReg: Record<string, (data: unknown) => Promise<void>> = {};
	class FakeWS {
		constructor(ctorOpts: unknown) {
			startCalls.push(ctorOpts);
		}
		async start(so: unknown) {
			startOpts.push(so as { onReconnecting?: () => void });
		}
		close() {
			/* noop */
		}
	}
	if (!opts?.legacySdk) {
		Object.assign(FakeWS.prototype, {
			getConnectionStatus: () => ({ state: "connected" }), // 对齐真实 SDK 1.73（有快照方法）
		});
	}
	if (opts?.serverPingIntervalMs !== undefined) {
		Object.assign(FakeWS.prototype, {
			wsConfig: { getWS: () => ({ pingInterval: opts.serverPingIntervalMs }) },
		});
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
	const keeper = new WsKeeper(sdk, {
		credentials: { appId: "a", appSecret: "s" },
		onMessage: () => {},
		reply: async (t) => {
			opts?.replies?.push(t);
		},
		log: (m) => logs.push(m),
		exit: () => {},
		...(opts?.checkCompeting ? { checkCompeting: opts.checkCompeting } : {}),
	});
	return { keeper, dispatcherReg, logs, startCalls, startOpts };
}
