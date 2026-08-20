# pi-feishu

pi 会话的飞书"远程驾驶舱"扩展 — 把飞书群变成 pi 会话的播报与遥控入口。

## 功能

### 出站播报
- `/feishu-follow on` 的会话在 `agent_end` 时把 AI 最终回复推送到飞书群（带 `[pi:会话名]` 前缀）
- `ask_user_question` 挂起时推送"等待输入"提醒（含问题摘要）
- 回复超过阈值（默认 2000 字符）时：群里发截断摘要 + 全文写入飞书文档 + 链接回群

### 入站遥控
- 群里 `@bot <会话名> <指令>` 注入对应 pi 会话（忙时 steer 打断插话，闲时 triggerTurn 触发新回合）
- `@bot list` 列出当前在线 follow 会话
- 双闸安全：@bot 提及（mentions 数组匹配）+ open_id 白名单，空名单默认拒绝

### 多会话群控
- 单 bot + 名字路由：会话名默认取 cwd 目录名，冲突自动加后缀，`/feishu-name` 手改
- claim 文件仲裁（`~/.pi/agent/feishu-bridge/claim.json`）

## 安装

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["pi-feishu"]
}
```

## 配置

```jsonc
// settings.json（全局或项目级 .pi/settings.json）
{
  "feishu": {
    "chatId": "oc_xxx",              // 目标群 chat_id
    "whitelist": ["ou_xxx"],         // 允许遥控的 open_id，空 = 全拒绝
    "truncateThreshold": 2000,       // 长回复截断阈值
    "sessionName": "my-session"      // 可选：会话名覆盖
  }
}
```

凭据通过环境变量传入（不入库）：

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
```

缺失凭据时扩展静默不激活，`/feishu-follow on` 会提示配置方法。

## 命令

| 命令 | 说明 |
|------|------|
| `/feishu-follow on` | 认领会话：开始播报 + 可被 @bot 路由 |
| `/feishu-follow off` | 释放会话，断开连接 |
| `/feishu-follow status` | 查看绑定状态 |
| `/feishu-name <名字>` | 修改会话名 |

## 飞书应用前置

1. 开放平台创建**自建应用**，开启机器人能力
2. 权限：`im:message`（收发消息）、`docx:document`（文档导出）
3. 事件订阅：WebSocket 模式，订阅 `im.message.receive_v1`
4. 发布版本并拉进群

## 测试与检查

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit（发版门禁）
```
