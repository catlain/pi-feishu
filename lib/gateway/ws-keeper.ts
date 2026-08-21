/**
 * WS 连接管理器 — 基于 SDK 内置 watchdog 判活 + 退避重建
 *
 * SDK WSClient 自带：断线自动重连循环（onReconnecting/onReconnected）、
 * pingTimeout liveness watchdog（协议层心跳判活）、terminalError（SDK 放弃）。
 * 我们负责：监听回调（日志+群播报）、SDK terminal 后销毁整个 client
 * 用退避状态机重建（1s×2 封顶 60s）、旧 SDK 无快照时事件水位兜底。
 * D2 帧水位判死已退役：pong 在 SDK 内部处理不触发 dispatcher 帧计数，
 * 「无入帧」与「连接死」无因果（两次真机静默期误杀实锤）；lastFrameAt 仅观测。
 */

import type { EventDispatcher } from "@larksuiteoapi/node-sdk";
import {
	initReconnectState,
	tickReconnect,
	isWsDead,
	clearLock,
	type ReconnectState,
} from "./lifecycle";
import { DiagReporter, WS_PING_TIMEOUT_S } from "./ws-diagnostics";
import type { SdkLogger } from "./stdio";

/** liveness watchdog 超时（秒）：见 ws-diagnostics.ts 的 WS_PING_TIMEOUT_S */

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
	/** 运行期竞争连接检测（同 app 第二 WS 会随机分流事件）；异步发起、结果经回调交付
	 * （T2：30s 循环内零同步子进程调用）；不传则不监测 */
	checkCompeting?: (onResult: (r: Array<{ pid: number; cmd: string }>) => void) => void;
}

export class WsKeeper {
	private opts: WsKeeperOptions;
	private sdk: typeof import("@larksuiteoapi/node-sdk");
	private ws: import("@larksuiteoapi/node-sdk").WSClient | null = null;
	private terminal = false; // SDK 已放弃（onError）
	private startCount = 0;
	private lastEventAt = Date.now();
	/** 最近一次入站帧（dispatcher 入口刷新，去重前）— 仅观测（diag 快照），不作判据（D2 退役） */
	private lastFrameAt = Date.now();
	/** 最近一次出站成功 — 仅观测（diag 快照），不作判据（D2 退役） */
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
		this.diag = new DiagReporter(opts.log);
	}

	/**
	 * 综合判活（D2 帧水位判死已退役——pong 在 SDK 内部处理不触发 dispatcher 帧计数，
	 * 「无入帧」与「连接死」无因果，两次真机静默期误杀实锤）：
	 * 1. SDK 官方快照（connected/reconnecting/connecting → 健康，failed/idle → 重建）。
	 * 2. 快照不可用（旧 SDK）→ 回退事件水位（isWsDead，仅旧 SDK 路径）。
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

	/** diag 快照输出器（5 分钟节流常驻观测，T4 转正；实现在 ws-diagnostics.ts） */
	private diag: DiagReporter;

	/** 健康快照：委托 DiagReporter（节流/watchdog 参数可见性在观测模块） */
	diagSnapshot(): void {
		this.diag.snapshot({
			terminal: this.terminal,
			lastFrameAt: this.lastFrameAt,
			lastOutboundAt: this.lastOutboundAt,
			startCount: this.startCount,
			ws: this.ws,
		});
	}

	/** 出站成功回调（main.ts 接线）：刷新出站观测水位（diag 快照用） */
	notifyOutboundOk(): void {
		this.lastOutboundAt = Date.now();
	}

	/** 建立全新 WSClient（首次与整体重启共用；SDK 断线自愈由其内置循环负责） */
	async start(): Promise<void> {
		this.opts.log(`[ws-life] start() 进入（第 ${this.startCount = (this.startCount ?? 0) + 1} 次）`);
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
			...(this.opts.logger ? { logger: this.opts.logger } : {}),
			// SDK 类型声明未收录 loggerLevel（运行时支持，真机已验证 debug 帧）；cast 绕过
			...(this.opts.loggerLevel !== undefined ? { loggerLevel: this.opts.loggerLevel } : {}),
			// liveness watchdog（SDK ≥1.64.0，官方 commit dc28142）：距上次 ping 后 pingTimeout 秒无任何入站帧
			// （含 pong）→ 主动 terminate 触发标准重连。⚠️ 必须在构造器 wsConfig 传，start() 参数无效。
			// 默认关闭（?? 0）；须大于服务端 pingInterval(默认120s)+余量——90s 版曾在静默期周期性自杀
			// （watchdog fire→重连→过渡窗丢消息，2026-08-21 实锤），取 240（见 WS_PING_TIMEOUT_S）
			wsConfig: { pingTimeout: WS_PING_TIMEOUT_S },
		} as ConstructorParameters<typeof import("@larksuiteoapi/node-sdk").WSClient>[0]);
		await this.ws.start({
			eventDispatcher: dispatcher as unknown as EventDispatcher,
			onError: (err: Error) => {
				this.terminal = true;
				this.opts.log(`SDK 重连最终失败（terminal）: ${err.message}`);
			},
			onReconnecting: () => {
				// D5：重连中不算「有事件进来」，不刷新观测水位——否则重连风暴会无限掩盖静默
				this.opts.log("SDK 检测到断开，进入内置重连循环");
				// T4.2：重连（含 watchdog terminate 触发）即时群播——用户实时区分「重连窗口丢」vs「稳态丢」；
				// 60s 节流防重连风暴刷屏（SDK 内置循环周期性触发本回调）
				const now = Date.now();
				if (now - this.lastReconnectNoticeAt > 60_000) {
					this.lastReconnectNoticeAt = now;
					void this.opts.reply("[pi] 网关连接重连中，稍后若未响应请重发");
				}
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
		// T4.3：启动即打印生效 watchdog 参数——参数倒挂（如 90<120）可被日志一眼发现
		this.opts.log(
			`watchdog 参数: pingTimeout=${WS_PING_TIMEOUT_S}s（须 > 服务端 pingInterval 默认 120s，下发值见后续 diag 快照/握手日志）`,
		);
		// 启动就绪播报：飞书服务端切到新连接有过渡期（实测可达 4 分钟，期间事件丢弃不重投），
		// 群里收到本条仅代表出站通，入站真正恢复以能收到指令为准
		void this.opts.reply("[pi] 网关已就绪（预热中：约 5 分钟内指令可能被丢弃，未响应请重发）");
	}

	/** 启动兜底扫描循环（30s）：SDK terminal 或水位死亡时整体重建；持续失败 30 分钟熔断 */
	/** 运行期竞争连接监测：发现同 app 其他 WS 客户端即群播警告（5 分钟节流） */
	private lastCompeteWarnAt = 0;
	/** 重连群播节流（T4.2：防重连风暴刷屏） */
	private lastReconnectNoticeAt = 0;

	startReconnectLoop(onGiveup: () => void): void {
		this.timer = setInterval(() => {
			try {
				const now = Date.now();
				const connected = this.isConnected(now);

				// 运行期竞争监测（需注入 checkCompeting 回调）：同 app 第二连接会随机分流事件，
				// 是「时通时不通」的已实锤元凶；只在 on/status 扫一次不够（幽灵进程随时可起）。
				// T2：扫描异步发起，结果经回调群播——循环内无同步子进程调用
				if (this.opts.checkCompeting && connected && now - this.lastCompeteWarnAt > 300_000) {
					this.opts.checkCompeting((rivals: Array<{ pid: number; cmd: string }>) => {
						const t = Date.now();
						if (rivals.length > 0) {
							this.lastCompeteWarnAt = t;
							this.opts.log(
								`⚠️ 检测到竞争飞书 WS 客户端（${rivals.length} 个）：${rivals.map((r) => `PID ${r.pid}`).join("、")}`,
							);
							void this.opts.reply(
								`[pi] ⚠️ 检测到 ${rivals.length} 个其他飞书 WS 客户端在抢事件（网关时通时不通的元凶），请关闭对应进程：${rivals.map((r) => `PID ${r.pid}`).join("、")}`,
							);
						} else {
							this.lastCompeteWarnAt = t - 240_000; // 无竞争时 1 分钟后再查
						}
					});
				}

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
