/**
 * WS 连接管理器 — 基于 SDK 内置重连 + 我们的水位兜底与整体重启
 *
 * SDK WSClient 自带：断线自动重连循环（onReconnecting/onReconnected）、
 * pingTimeout liveness watchdog、terminalError（SDK 放弃）。
 * 我们负责：监听回调（日志+群播报）、SDK terminal 后销毁整个 client
 * 用退避状态机重建（1s×2 封顶 60s）、3 分钟事件水位兜底（SDK 看门狗失效时）。
 */

import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import {
	initReconnectState,
	tickReconnect,
	isWsDead,
	clearLock,
	type ReconnectState,
} from "./lifecycle";
import type { SdkLogger } from "./stdio";

export interface WsKeeperOptions {
	credentials: { appId: string; appSecret: string };
	onMessage: (data: unknown) => void;
	reply: (text: string) => Promise<void>;
	log: (msg: string) => void;
	/** 熔断收尾（清锁+退出） */
	exit: (code: number) => void;
	/** 注入 SDK 的文件流 logger（EPIPE 根治） */
	logger?: SdkLogger;
}

export class WsKeeper {
	private opts: WsKeeperOptions;
	private sdk: typeof import("@larksuiteoapi/node-sdk");
	private ws: import("@larksuiteoapi/node-sdk").WSClient | null = null;
	private terminal = false; // SDK 已放弃（onError）
	private lastEventAt = Date.now();
	private hadConnectedOnce = false;
	private reconnect: ReconnectState = initReconnectState();
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		sdk: typeof import("@larksuiteoapi/node-sdk"),
		opts: WsKeeperOptions,
	) {
		this.sdk = sdk;
		this.opts = opts;
	}

	/**
	 * 综合判活：优先轮询 SDK 官方快照 getConnectionStatus()。
	 * - connected / reconnecting / connecting → 健康（reconnecting 是 SDK 自愈中，不干预）
	 * - failed（onError terminal）或异常 idle → 不健康（走退避状态机整体重建）
	 * - getConnectionStatus 不可用（旧 SDK）→ 回退事件水位判活（isWsDead）
	 */
	isConnected(now: number): boolean {
		if (this.terminal || !this.ws) return false;
		const statusFn = (this.ws as { getConnectionStatus?: () => { state?: string } })
			.getConnectionStatus;
		if (typeof statusFn === "function") {
			try {
				const state = statusFn.call(this.ws)?.state;
				if (state === "connected" || state === "reconnecting" || state === "connecting") {
					return true;
				}
				// failed / idle / 未知 → 视为不健康，交退避状态机决定是否重建
				return false;
			} catch {
				// 快照读取异常 → 回退水位
			}
		}
		return !isWsDead(this.lastEventAt, now);
	}

	connectedOnce(): boolean {
		return this.hadConnectedOnce;
	}

	/** 已处理 eventId 去重（防官方 3s 超时重推导致重复注入）；滚动保留最近 256 条 */
	private seenEventIds = new Set<string>();
	private seenEventIdsRing: string[] = [];

	/** 建立全新 WSClient（首次与整体重启共用；SDK 断线自愈由其内置循环负责） */
	async start(): Promise<void> {
		this.terminal = false;
		this.lastEventAt = Date.now();
		const dispatcher = new this.sdk.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				this.lastEventAt = Date.now();
				// eventId 去重：官方 3s 超时重推会重复送达同一事件
				const evId = (data as { header?: { event_id?: string } })?.header?.event_id;
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
			...(this.opts.logger ? { logger: this.opts.logger } : {}),
			...(this.opts.loggerLevel !== undefined ? { loggerLevel: this.opts.loggerLevel } : {}),
		});
		await this.ws.start({
			eventDispatcher: dispatcher as unknown as EventDispatcher,
			// liveness watchdog：60s 无 pong 判死，SDK 自动进入内置重连循环
			pingTimeout: 60,
			onError: (err: Error) => {
				this.terminal = true;
				this.opts.log(`SDK 重连最终失败（terminal）: ${err.message}`);
			},
			onReconnecting: () => {
				this.lastEventAt = Date.now(); // SDK 在重连中，不算静默死
				this.opts.log("SDK 检测到断开，进入内置重连循环");
			},
			onReconnected: () => {
				this.lastEventAt = Date.now();
				this.opts.log("SDK 重连成功");
				void this.opts.reply("[pi] 网关连接已恢复（期间指令若有丢失请重发）");
			},
		} as never);
		this.hadConnectedOnce = true;
		this.lastEventAt = Date.now();
		this.opts.log("WS 长连接已建立（全机器唯一客户端，SDK 内置重连 + 水位兜底）");
		// 启动就绪播报：飞书服务端切到新连接有过渡期（实测约 1 分钟内，期间事件丢弃不重投），
		// 群里收到本条即代表可正常遥控
		void this.opts.reply("[pi] 网关已就绪");
	}

	/** 启动兜底扫描循环（30s）：SDK terminal 或水位死亡时整体重建；持续失败 30 分钟熔断 */
	startReconnectLoop(onGiveup: () => void): void {
		this.timer = setInterval(() => {
			try {
				const now = Date.now();
				const connected = this.isConnected(now);

				if (connected && this.reconnect.deadSince !== null) {
					this.opts.log("WS 连接已恢复（整体重启成功）");
					void this.opts.reply("[pi] 网关连接已恢复（期间指令若有丢失请重发）");
				}

				const rc = tickReconnect(this.reconnect, connected, now);
				if (rc.action === "reconnect") {
					this.opts.log(
						`WS 不可用，整体重建 WSClient（第 ${this.reconnect.failures} 次，退避 ${rc.delayMs}ms）`,
					);
					void this.start().catch((err) => {
						this.opts.log(
							`重建失败: ${err instanceof Error ? err.message : String(err)}`,
						);
						this.terminal = true; // 保持断开态，下轮继续
					});
				} else if (rc.action === "giveup") {
					this.opts.log("WS 持续 30 分钟无法恢复，熔断退出");
					this.stop();
					void this.opts.reply(
						"[pi] 网关持续无法连接飞书，已退出。请检查网络后执行 /feishu-gateway on",
					).finally(() => {
						clearLock();
						onGiveup();
					});
				}
			} catch (err) {
				this.opts.log(
					`兜底扫描异常: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}, 30_000);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
