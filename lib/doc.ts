/**
 * 长回复文档导出 — docx API 写全文，链接回群
 */

/** 飞书文档 API 最小结构类型（避免拉入完整 lark Client） */
export interface FeishuDocClient {
	docx: {
		document: { create: (args: unknown) => Promise<unknown> };
		documentBlock: { children: { create: (args: unknown) => Promise<unknown> } };
	};
}

export interface DocExportResult {
	ok: boolean;
	url?: string;
	error?: string;
}

/** 截断摘要格式：前 N 字符 + 省略提示（+链接占位） */
export function truncateForChat(
	text: string,
	threshold: number,
): string {
	if (text.length <= threshold) return text;
	const summaryLen = Math.max(200, Math.min(1500, Math.floor(threshold * 0.75)));
	return `${text.slice(0, summaryLen)}\n\n…（已截断，全文见文档）`;
}

/** 文档标题：[pi] {会话名} {时间} {主题首行} */
export function buildDocTitle(sessionName: string, text: string): string {
	const now = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const time = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
	const firstLine = text.trim().split("\n")[0]?.slice(0, 40) || "回复";
	return `[pi] ${sessionName} ${time} ${firstLine}`;
}

/** 将长文本切成 docx block children（按段落数组） */
export function textToBlocks(text: string): Array<{
	blockType: number;
	text: { elements: [{ textRun: { content: string } }] };
}> {
	const paragraphs = text.split(/\n/).map((l) => l || " ");
	return paragraphs.map((line) => ({
		blockType: 2, // text block
		text: {
			elements: [{ textRun: { content: line } }],
		},
	}));
}

/**
 * 创建飞书文档并写入全文。失败返回 { ok:false, error }（上层降级）。
 */
export async function exportToDoc(
	client: FeishuDocClient,
	title: string,
	text: string,
): Promise<DocExportResult> {
	try {
		const createRes = (await client.docx.document.create({
			data: { title },
		})) as unknown as {
			code?: number;
			msg?: string;
			data?: { document?: { document_id?: string } };
		};
		if (createRes.code !== 0 || !createRes.data?.document?.document_id) {
			return {
				ok: false,
				error: `创建文档失败 code=${createRes.code} msg=${createRes.msg}`,
			};
		}
		const docId = createRes.data.document.document_id;

		const blockRes = (await client.docx.documentBlock.children.create({
			path: { document_id: docId, block_id: docId },
			data: { children: textToBlocks(text), index: 0 },
		})) as unknown as { code?: number; msg?: string };
		if (blockRes.code !== 0) {
			return { ok: false, error: `写入文档失败 code=${blockRes.code} msg=${blockRes.msg}` };
		}
		return { ok: true, url: `https://feishu.cn/docx/${docId}` };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
