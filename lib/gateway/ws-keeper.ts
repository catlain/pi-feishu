/**
 * WS 连接管理器 — 极简版（feishu-gateway-simplify）
 *
 * 职责仅剩：建连（SDK 客户端 + dispatcher）、eventId 去重、stop()。
 * 连接管理全权交 SDK（D2）：不传 pingTimeout、不注入 logger、
 * 无判活/重连/退避状态机——SDK 内置自动重连兜底。
 * 日志：SDK 用默认 console logger，经 spawn 层 stdio 重定向捕获到 gateway.log（D1）。
 */

import type { EventDispatcher } from "@larksuiteoapi/node-sdk";

export interface WsKeeperOptions {
	credentials: { appId: string; appSecret: string };
	onMessage: (data: unknown) => void;
	reply: (text: string) => Promise<void>;
	log: (msg: string) => void;
}

export class WsKeeper {
	private opts: WsKeeperOptions;
	private sdk: typeof import("@larksuiteoapi/node-sdk");
	private ws: import("@larksuiteoapi/node-sdk").WSClient | null = null;

	constructor(
		sdk: typeof import("@larksuiteoapi/node-sdk"),
		opts: WsKeeperOptions,
	) {
		this.sdk = sdk;
		this.opts = opts;
	}

	/** 已处理 eventId 去重（防官方 3s 超时重推导致重复注入）；滚动保留最近 256 条 */
	private seenEventIds = new Set<string>();
	private seenEventIdsRing: string[] = [];

	/** 建立 WS 连接（仅一次；断线自愈由 SDK 内置循环负责） */
	async start(): Promise<void> {
		const dispatcher = new this.sdk.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				// eventId 去重：官方 3s 超时重推会重复送达同一事件。
				// schema 2.0 事件 event_id 在顶层；旧 schema 在 header.event_id（兼容双读）
				const ev = data as { event_id?: string; header?: { event_id?: string } };
				const evId = ev?.event_id ?? ev?.header?.event_id;
				if (evId) {
					if (this.seenEventIds.has(evId)) {
						this.opts.log(`重复事件丢弃（eventId=${evId}，官方重推机制）`);
						return;
					}
					this.seenEventIds.add(evId);
					this.seenEventIdsRing.push(evId);
					if (this.seenEventIdsRing.length > 256) {
						const old = this.seenEventIdsRing.shift();
						if (old) this.seenEventIds.delete(old);
					}
				}
				try {
					this.opts.onMessage(data);
				} catch (err) {
					this.opts.log(
						`入站处理异常: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			},
		});
		this.ws = new this.sdk.WSClient({
			appId: this.opts.credentials.appId,
			appSecret: this.opts.credentials.appSecret,
			// 零注入：无 logger / loggerLevel / wsConfig——行为 100% 交 SDK 标准路径（D1/D2）
		} as ConstructorParameters<typeof import("@larksuiteoapi/node-sdk").WSClient>[0]);
		await this.ws.start({
			eventDispatcher: dispatcher as unknown as EventDispatcher,
			onError: (err: Error) => {
				this.opts.log(`SDK 重连最终失败（terminal）: ${err.message}`);
			},
			onReconnecting: () => {
				this.opts.log("SDK 检测到断开，进入内置重连循环");
				void this.opts.reply("[pi] 网关连接重连中，稍后若未响应请重发");
			},
			onReconnected: () => {
				this.opts.log("SDK 重连成功");
				void this.opts.reply("[pi] 网关连接已恢复（期间指令若有丢失请重发；刚恢复后约 1 分钟内发送的指令可能被丢弃，若未响应请稍候重发）");
			},
		} as never);
		this.opts.log("WS 长连接已建立（SDK 内置自动重连负责断线恢复）");
		// 启动就绪播报：飞书服务端切到新连接有过渡期（实测可达 4 分钟，期间事件丢弃不重投）
		void this.opts.reply("[pi] 网关已就绪（预热中：约 5 分钟内指令可能被丢弃，未响应请重发）");
	}

	stop(): void {
		const ws = this.ws as unknown as { close?: () => void; disconnect?: () => void } | null;
		if (ws) {
			try {
				if (typeof ws.close === "function") ws.close();
				else if (typeof ws.disconnect === "function") ws.disconnect();
			} catch {
				// 尽力而为
			}
			this.ws = null;
		}
	}
}
