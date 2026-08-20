/**
 * 飞书客户端 — WS 长连接生命周期 + 出站消息
 *
 * 群岛生态首个常驻外连模式：
 * - follow on 时建立连接，off / session_shutdown 断开
 * - SDK 自动重连，重连后由上层重校验 claim
 */

import type { Client, WSClient, EventDispatcher } from "@larksuiteoapi/node-sdk";
import type { FeishuCredentials } from "./credentials";
import type { FeishuMessageEvent } from "./types";

export interface FeishuClientOptions {
	credentials: FeishuCredentials;
	chatId: string;
	/** 收到入站事件回调 */
	onEvent: (data: FeishuMessageEvent) => void;
	/** 本 bot 的 open_id（@bot 检测），启动后可通过 setBotOpenId 更新 */
	logger?: (msg: string) => void;
}

export class FeishuBridgeClient {
	private ws: WSClient | null = null;
	private client: Client | null = null;
	private connected = false;
	private opts: FeishuClientOptions;

	constructor(opts: FeishuClientOptions) {
		this.opts = opts;
	}

	/** 惰性加载 SDK（jiti/CJS 下 require ESM 包也可，但惰性 import 保持加载安全） */
	private async loadSdk() {
		return await import("@larksuiteoapi/node-sdk");
	}

	/** 建立 WS 长连接 */
	async connect(): Promise<void> {
		if (this.connected) return;
		const sdk = await this.loadSdk();
		const { Client, WSClient, EventDispatcher, LoggerLevel } = sdk;

		this.client =
			this.client ??
			new Client({
				appId: this.opts.credentials.appId,
				appSecret: this.opts.credentials.appSecret,
			});

		const dispatcher = new EventDispatcher({}).register({
			"im.message.receive_v1": async (data: unknown) => {
				try {
					this.opts.onEvent(data as FeishuMessageEvent);
				} catch {
					// 入站处理异常不影响 WS 连接
				}
			},
		});

		this.ws = new WSClient({
			appId: this.opts.credentials.appId,
			appSecret: this.opts.credentials.appSecret,
		});
		await this.ws.start({
			eventDispatcher: dispatcher as unknown as EventDispatcher,
		} as never);
		this.connected = true;
		this.opts.logger?.("[pi-feishu] WS 长连接已建立");
	}

	/** 断开连接（off / session_shutdown） */
	async disconnect(): Promise<void> {
		this.connected = false;
		const ws = this.ws;
		this.ws = null;
		try {
			// SDK 的 WSClient 提供 close；若无则置空由 GC 回收
			(ws as unknown as { close?: () => void })?.close?.();
		} catch {
			// 忽略断开异常
		}
	}

	isConnected(): boolean {
		return this.connected;
	}

	/** 暴露内部 Client（出站播报 / 文档导出复用） */
	rawClient(): Client {
		return this.client as Client;
	}

	/** 确保 Client 已初始化（未连接时也可用于出站） */
	async ensureClient(): Promise<Client> {
		if (!this.client) {
			const sdk = await this.loadSdk();
			this.client = new sdk.Client({
				appId: this.opts.credentials.appId,
				appSecret: this.opts.credentials.appSecret,
			});
		}
		return this.client;
	}

	/** 获取 bot 自身 open_id（mentions 匹配用）。SDK 无公开 bot.info 封装，用 request 对象形式调 /bot/v3/info */
	async fetchBotOpenId(): Promise<string | null> {
		if (!this.client) return null;
		try {
			const res = (await this.client.request({
				url: "/open-apis/bot/v3/info",
				method: "GET",
			} as never)) as { bot?: { open_id?: string } };
			return res?.bot?.open_id ?? null;
		} catch {
			return null;
		}
	}

	/** 发送群文本消息，失败返回 null（静默降级） */
	async sendText(chatId: string, text: string): Promise<string | null> {
		if (!this.client) return null;
		try {
			const res = await this.client.im.message.create({
				data: {
					receive_id: chatId,
					content: JSON.stringify({ text }),
					msg_type: "text",
				},
				params: { receive_id_type: "chat_id" },
			});
			const messageId = (res as { data?: { message_id?: string } })?.data
				?.message_id;
			return messageId ?? null;
		} catch (err) {
			this.opts.logger?.(
				`[pi-feishu] 发送失败: ${err instanceof Error ? err.message : String(err)}`,
			);
			return null;
		}
	}
}
