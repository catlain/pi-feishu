#!/usr/bin/env node
/** pi-feishu-gateway 启动器 — 用 jiti 加载 TS 网关入口 */
const path = require("path");
const { createRequire } = require("module");

const req = createRequire(__dirname);
let jiti;
try {
	jiti = req("jiti");
} catch {
	// dev 场景：从上层安装解析
	jiti = require("jiti");
}

const run = jiti();
run(path.join(__dirname, "..", "lib", "gateway", "main.ts"));
