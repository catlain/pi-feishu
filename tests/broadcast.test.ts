import { describe, expect, it, vi } from "vitest";
import {
	broadcastAskWaiting,
	broadcastReply,
	buildAskWaitingBody,
	summarizeQuestions,
} from "../lib/broadcast";
import {
	buildDocTitle,
	exportToDoc,
	textToBlocks,
	truncateForChat,
} from "../lib/doc";
import type { FeishuConfig } from "../lib/types";

const config: FeishuConfig = {
	chatId: "c1",
	whitelist: [],
	truncateThreshold: 2000,
};

function makeClient(impl?: { create?: ReturnType<typeof vi.fn> }) {
	const create = impl?.create ?? vi.fn().mockResolvedValue({ code: 0, data: { message_id: "m1" } });
	const client = { im: { message: { create } } };
	return client;
}

describe("播报", () => {
	it("阈值内直发（带会话名前缀）", async () => {
		const client = makeClient();
		const r = await broadcastReply(
			{ client, getDocClient: () => null, config },
			"quant",
			"短回复",
		);
		expect(r.sent).toBe(true);
		expect(r.truncated).toBe(false);
		const arg = (client.im.message.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(JSON.parse(arg.data.content).text).toContain("[pi:quant]");
	});

	it("超阈值截断 + 文档导出 + 链接回群", async () => {
		const long = "x".repeat(2500);
		const client = makeClient();
		const r = await broadcastReply(
			{
				client,
				getDocClient: () =>
					({
						docx: {
							document: { create: vi.fn().mockResolvedValue({ code: 0, data: { document: { document_id: "d1" } } }) },
							documentBlock: { children: { create: vi.fn().mockResolvedValue({ code: 0 }) } },
						},
					}) as never,
				config,
			},
			"quant",
			long,
		);
		expect(r.truncated).toBe(true);
		expect(r.docUrl).toBe("https://feishu.cn/docx/d1");
		const arg = (client.im.message.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		expect(JSON.parse(arg.data.content).text).toContain("https://feishu.cn/docx/d1");
	});

	it("文档创建失败降级：仍发截断内容 + 失败提示", async () => {
		const long = "y".repeat(2500);
		const client = makeClient();
		const r = await broadcastReply(
			{
				client,
				getDocClient: () =>
					({
						docx: {
							document: { create: vi.fn().mockResolvedValue({ code: 230002, msg: "no permission" }) },
						},
					}) as never,
				config,
			},
			"quant",
			long,
		);
		expect(r.sent).toBe(true);
		expect(r.docUrl).toBeUndefined();
		expect(r.error).toContain("no permission");
	});

	it("发送异常静默降级不抛出", async () => {
		const client = makeClient({ create: vi.fn().mockRejectedValue(new Error("net")) });
		const r = await broadcastReply({ client, getDocClient: () => null, config }, "q", "hi");
		expect(r.sent).toBe(false);
	});

	it("ask-user 等待提醒含摘要", async () => {
		const client = makeClient();
		await broadcastAskWaiting({ client, getDocClient: () => null, config }, "quant", "选哪个？");
		const arg = (client.im.message.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
		const text = JSON.parse(arg.data.content).text;
		expect(text).toContain("⏸ 等待输入");
		expect(text).toContain("选哪个？");
	});

	it("summarizeQuestions 取首个问题", () => {
		expect(summarizeQuestions([{ question: "用哪个方案？", header: "方案" }])).toBe(
			"[方案] 用哪个方案？",
		);
	});

	describe("buildAskWaitingBody", () => {
		const singleQ = [
			{
				question: "用哪个方案？",
				header: "方案",
				options: [
					{ label: "A", description: "快" },
					{ label: "B" },
				],
			},
		];

		it("单题附编号选项和 answer 提示", () => {
			const body = buildAskWaitingBody("catlain", singleQ);
			expect(body).toContain("[方案] 用哪个方案？");
			expect(body).toContain("1. A — 快");
			expect(body).toContain("2. B");
			expect(body).toContain("回复 @bot catlain awr <编号> 选择");
		});

		it("多题提示回终端操作", () => {
			const body = buildAskWaitingBody("catlain", [
				...singleQ,
				{ question: "确认吗？", options: [{ label: "是" }] },
			]);
			expect(body).toContain("问题2: 确认吗？");
			expect(body).toContain("多题暂不支持飞书应答");
			expect(body).not.toContain("answer");
		});

		it("无选项时回退摘要", () => {
			expect(buildAskWaitingBody("catlain", [{ question: "Q?" }])).toBe("Q?");
			expect(buildAskWaitingBody("catlain", [])).toBe("AI 正在等待你的选择");
		});
	});
});

describe("doc 工具", () => {
	it("阈值判断与截断格式", () => {
		expect(truncateForChat("short", 2000)).toBe("short");
		const long = truncateForChat("z".repeat(3000), 2000);
		expect(long).toContain("…（已截断，全文见文档）");
		expect(long.length).toBeLessThan(2500);
	});

	it("文档标题格式", () => {
		const title = buildDocTitle("quant", "主题首行\n正文");
		expect(title).toMatch(/^\[pi\] quant \d{4}-\d{2}-\d{2} \d{2}:\d{2} 主题首行$/);
	});

	it("textToBlocks 按段落切分", () => {
		const blocks = textToBlocks("a\n\nb");
		expect(blocks).toHaveLength(3);
		expect(blocks[0]!.text.elements[0]!.textRun.content).toBe("a");
	});

	it("exportToDoc 成功返回链接", async () => {
		const client = {
			docx: {
				document: { create: vi.fn().mockResolvedValue({ code: 0, data: { document: { document_id: "d9" } } }) },
				documentBlock: { children: { create: vi.fn().mockResolvedValue({ code: 0 }) } },
			},
		} as never;
		const r = await exportToDoc(client, "t", "content");
		expect(r.ok).toBe(true);
		expect(r.url).toContain("d9");
	});

	it("exportToDoc 失败返回错误", async () => {
		const client = {
			docx: { document: { create: vi.fn().mockResolvedValue({ code: 1, msg: "err" }) } },
		} as never;
		const r = await exportToDoc(client, "t", "content");
		expect(r.ok).toBe(false);
		expect(r.error).toContain("err");
	});
});
