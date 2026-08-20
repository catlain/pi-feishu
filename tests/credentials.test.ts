import { describe, expect, it } from "vitest";
import { getCredentials } from "../lib/credentials";
import type { FeishuConfig } from "../lib/types";

describe("凭证读取", () => {
	it("settings feishu section 为主配置方式（优先于环境变量）", () => {
		process.env.FEISHU_APP_ID = "env_id";
		process.env.FEISHU_APP_SECRET = "env_secret";
		const r = getCredentials({ appId: "cfg_id", appSecret: "cfg_secret" } as FeishuConfig);
		expect(r).toEqual({ appId: "cfg_id", appSecret: "cfg_secret" });
		delete process.env.FEISHU_APP_ID;
		delete process.env.FEISHU_APP_SECRET;
	});

	it("环境变量作为兼容兜底", () => {
		delete process.env.FEISHU_APP_ID;
		delete process.env.FEISHU_APP_SECRET;
		process.env.FEISHU_APP_ID = "env_id";
		process.env.FEISHU_APP_SECRET = "env_secret";
		const r = getCredentials({} as FeishuConfig);
		expect(r).toEqual({ appId: "env_id", appSecret: "env_secret" });
		delete process.env.FEISHU_APP_ID;
		delete process.env.FEISHU_APP_SECRET;
	});

	it("两处都缺失返回 null（静默降级）", () => {
		delete process.env.FEISHU_APP_ID;
		delete process.env.FEISHU_APP_SECRET;
		expect(getCredentials({} as FeishuConfig)).toBeNull();
		expect(getCredentials(undefined)).toBeNull();
	});

	it("只配一半也返回 null", () => {
		delete process.env.FEISHU_APP_ID;
		delete process.env.FEISHU_APP_SECRET;
		expect(getCredentials({ appId: "only_id" } as FeishuConfig)).toBeNull();
	});
});
