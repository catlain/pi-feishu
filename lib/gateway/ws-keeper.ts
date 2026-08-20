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

/** 帧水位判死阈值：超过此时长无入站帧且期间有出站成功 → 判死重建 */
export const FRAME_DEAD_MS = 120_000;

export interface WsKeeperOptions {
	credentials: { appId: string; appSecret: string };
	onMessage: (data: unknown) => void;
	reply: (text: string) => Promise<void>;
	log: (msg: string) => void;
	/** 熔断收尾（清锁+退出） */
	exit: (code: number) => void;
	/** 注入 SDK 的文件流 logger（EPIPE 根治） */
	logger?: SdkLogger;
	/** SDK 日志级别（诊断期 4=debug，定位后移除） */
	loggerLevel?: number;
}

export class WsKeeper {
	private opts: WsKeeperOptions;
	private sdk: typeof import("@larksuiteoapi/node-sdk");
	private ws: import("@larksuiteoapi/node-sdk").WSClient | null = null;
	private terminal = false; // SDK 已放弃（onError）
	private lastEventAt = Date.now();
	/** 最近一次入站帧（dispatcher 入口刷新，去重前）— 帧水位优先判活用 */
	private lastFrameAt = Date.now();
	/** 最近一次出站成功（有出站证明服务端可达，静默期防误判用） */
	private lastOutboundAt: number | null = null;
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
	 * 综合判活：
	 * 1. SDK 官方快照优先（connected/reconnecting/connecting → 健康）。
	 *    ⚠️ 帧水位判死已禁用（FRAME_DEAD_ENV 环境变量才启用）：出站走 REST、入站走 WS，
	 *    静默期本就无入站帧，「有出站+无入帧=黑洞」不能成立（2026-08-20 真机误杀循环：
	 *    每 2 分钟静默重建一次）。WS 协议心跳（ping/pong）SDK 日志层不可见，无可靠判据。
	 * 2. 快照不可用（旧 SDK）→ 回退事件水位（isWsDead，仅旧 SDK 路径，保持历史行为）。
	 */
	isConnected(now: number): boolean {
		if (this.terminal || !this.ws) return false;
		// 实验性帧水位判死：仅环境变量 PI_FEISHU_FRAME_DEAD=1 显式启用
		if (process.env.PI_FEISHU_FRAME_DEAD === "1" && now - this.lastFrameAt > FRAME_DEAD_MS) {
			const outboundSinceFrame =
				this.lastOutboundAt !== null && this.lastOutboundAt > this.lastFrameAt;
			if (outboundSinceFrame) {
				this.opts.log(
					`帧水位判死（实验）：${Math.round((now - this.lastFrameAt) / 1000)}s 无入站帧 → 重建`,
				);
				return false;
			}
		}
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

	/** 出站成功回调（main.ts 接线）：刷新出站水位 */
	notifyOutboundOk(): void {
		this.lastOutboundAt = Date.now();
	}

	/** 建立全新 WSClient（首次与整体重启共用；SDK 断线自愈由其内置循环负责） */
	async start(): Promise<void> {
		// 重建原子性（D1）：先关旧 client，杜绝双连接分流（幽灵进程同款丢包形态）
		if (this.ws) {
			const old = this.ws as unknown as {
				close?: () => void;
				disconnect?: () => void;
			};
			let closed = false;
			try {
				if (typeof old.close === "function") {
					old.close();
					closed = true;
				} else if (typeof old.disconnect === "function") {
					old.disconnect();
					closed = true;
				}
			} catch {
				// 关闭失败也要置 null：旧实例不再挂新 dispatcher，不会双分发
			}
			this.opts.log(`重建：旧 client ${closed ? "已关闭" : "无公开关闭 API，置空引用脱离分发"}`);
			this.ws = null;
		}
		this.terminal = false;
		this.lastEventAt = Date.now();
		this.lastFrameAt = Date.now();
		const dispatcher = new this.sdk.EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				this.lastEventAt = Date.now();
				this.lastFrameAt = Date.now(); // 帧水位（去重前刷新）
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
			// SDK 类型声明未收录 loggerLevel（运行时支持，真机已验证 debug 帧）；cast 绕过
			...(this.opts.loggerLevel !== undefined ? { loggerLevel: this.opts.loggerLevel } : {}),
			// liveness watchdog（SDK ≥1.64.0，官方 commit dc28142）：距上次 ping 后 90s 无任何入站帧
			// （含 pong）→ 主动 terminate 触发标准重连。⚠️ 必须在构造器 wsConfig 传，start() 参数无效。
			// 默认关闭（?? 0）；半开连接分钟级无感知 → 90s 内强制重建（根因：go-sdk#224 / node-sdk#164）
			wsConfig: { pingTimeout: 90 },
		} as ConstructorParameters<typeof import("@larksuiteoapi/node-sdk").WSClient>[0]);
		await this.ws.start({
			eventDispatcher: dispatcher as unknown as EventDispatcher,
			onError: (err: Error) => {
				this.terminal = true;
				this.opts.log(`SDK 重连最终失败（terminal）: ${err.message}`);
			},
			onReconnecting: () => {
				// D5：重连中不算「有事件进来」，不刷新帧水位——否则重连风暴会无限掩盖静默
				this.opts.log("SDK 检测到断开，进入内置重连循环");
			},
			onReconnected: () => {
				this.lastEventAt = Date.now();
				this.lastFrameAt = Date.now(); // 真恢复：刷新帧水位
				this.opts.log("SDK 重连成功");
				void this.opts.reply("[pi] 网关连接已恢复（期间指令若有丢失请重发；刚恢复后约 1 分钟内发送的指令可能被丢弃，若未响应请稍候重发）");
			},
		} as never);
		this.hadConnectedOnce = true;
		this.lastEventAt = Date.now();
		this.lastFrameAt = Date.now();
		this.opts.log("WS 长连接已建立（全机器唯一客户端，SDK 内置重连 + 水位兜底）");
		// 启动就绪播报：飞书服务端切到新连接有过渡期（实测约 1 分钟内，期间事件丢弃不重投），
		// 群里收到本条即代表可正常遥控
		void this.opts.reply("[pi] 网关已就绪（约 1 分钟内发送的指令可能被丢弃，若未响应请重发）");
	}

	/** 启动兜底扫描循环（30s）：SDK terminal 或水位死亡时整体重建；持续失败 30 分钟熔断 */
	startReconnectLoop(onGiveup: () => void): void {
		this.timer = setInterval(() => {
			try {
				const now = Date.now();
				const connected = this.isConnected(now);

				if (connected && this.reconnect.deadSince !== null) {
					this.opts.log("WS 连接已恢复（整体重启成功）");
					void this.opts.reply("[pi] 网关连接已恢复（期间指令若有丢失请重发；刚恢复后约 1 分钟内发送的指令可能被丢弃，若未响应请稍候重发）");
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
