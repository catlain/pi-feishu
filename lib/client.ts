/**
 * 飞书客户端 — 会话侧仅保留出站 REST（sendText / rawClient / fetchBotOpenId）
 * WS 长连接逻辑已移入网关进程（lib/gateway/main.ts）。
 */

import type { Client } from "@larksuiteoapi/node-sdk";
import type { FeishuCredentials } from "./credentials";

export interface FeishuClientOptions {
	credentials: FeishuCredentials;
	logger?: (msg: string) => void;
}

export class FeishuBridgeClient {
	private client: Client | null = null;
	private opts: FeishuClientOptions;

	constructor(opts: FeishuClientOptions) {
		this.opts = opts;
	}

	/** 惰性加载 SDK */
	private async loadSdk() {
		return await import("@larksuiteoapi/node-sdk");
	}

	/** 确保 Client 初始化（出站播报 / 文档导出用） */
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

	/** 暴露内部 Client */
	rawClient(): Client | null {
		return this.client;
	}

	/** 获取 bot 自身 open_id */
	async fetchBotOpenId(): Promise<string | null> {
		const client = await this.ensureClient();
		try {
			const res = (await client.request({
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
		const client = await this.ensureClient();
		try {
			const res = await client.im.message.create({
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
