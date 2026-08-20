# pi-feishu

pi 会话的飞书"远程驾驶舱"扩展 — 把飞书群变成 pi 会话的播报与遥控入口。

## 功能

### 出站播报
- `/feishu-follow on` 的会话在 `agent_end` 时把 AI 最终回复推送到飞书群（带 `[pi:会话名]` 前缀）
- `ask_user_question` 挂起时推送"等待输入"提醒（含问题摘要）
- 回复超过阈值（默认 2000 字符）时：群里发截断摘要 + 全文写入飞书文档 + 链接回群

### 入站遥控（网关模式）
- **独立网关进程**（`pi-feishu-gateway`）持有全机器唯一飞书 WS 长连接，承担全部入站逻辑（解析/双闸校验/路由/list/报错）
- 群里 `@bot <会话名> <指令>`：网关写入待办文件（`~/.pi/agent/feishu-bridge/pending/<sessionId>.json`），目标会话 ~2s 轮询后注入（忙时 steer 打断插话，闲时 triggerTurn 触发新回合）
- `@bot list` 由网关直接回复所有心跳存活的 follow 会话
- 双闸安全（单点执行于网关）：@bot 提及（mentions 数组匹配）+ open_id 白名单，空名单默认拒绝

### 多会话群控
- 单 bot + 名字路由：会话名默认取 cwd 目录名，冲突自动加后缀，`/feishu-name` 手改
- claim 文件仲裁（`~/.pi/agent/feishu-bridge/claim.json`），会话存活 = 30s 心跳（>60s 无心跳视为离线）

## 架构（网关模式）

```
飞书群 ──WS──▶ 网关进程（pi-feishu-gateway，唯一 WS 客户端）
                 │ 解析/@bot 检测/白名单/名字路由（claim 心跳判活）
                 ├─ list、报错 ──REST──▶ 群
                 └─ 写 pending/<sessionId>.json
                                          │ ~2s 轮询
              各 pi 会话（薄客户端）◀──────┘
                 ├─ 本地注入（sendMessage + triggerTurn/steer）
                 └─ 出站播报（agent_end）──REST 直发──▶ 群（不经网关）
```

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
    "appId": "cli_xxx",              // 飞书自建应用凭证（主配置方式）
    "appSecret": "xxx",
    "whitelist": ["ou_xxx"],         // 允许遥控的 open_id，空 = 全拒绝
    "truncateThreshold": 2000,       // 长回复截断阈值
    "sessionName": "my-session"      // 可选：会话名覆盖
  }
}
```

> 凭证兼容环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`（优先级低于 settings 配置）。
> ⚠️ 注意：pi 不注入 settings.json 顶层 `env` 段到扩展进程，凭证请配在 `feishu` section 内。

缺失凭证时扩展静默不激活，`/feishu-follow on` 会提示配置方法。

## 命令

| 命令 | 说明 |
|------|------|
| `/feishu-follow on` | 认领会话：写 claim（含心跳）+ 出站播报 + 可被网关路由 |
| `/feishu-follow off` | 释放会话，停止心跳与轮询 |
| `/feishu-follow status` | 查看绑定状态 |
| `/feishu-name <名字>` | 修改会话名 |
| `/feishu-gateway on` | 启动网关进程（唯一 WS；已运行则提示 PID） |
| `/feishu-gateway off` | 停止网关进程并清锁（出站播报不受影响） |
| `/feishu-gateway status` | 网关运行状态 + claim 会话心跳概览 |

> 使用顺序：先 `/feishu-gateway on`，再各会话 `/feishu-follow on`。网关未运行时入站无响应，出站正常。
> 网关空闲自退：连续 10 分钟无任何存活心跳 → 群播报后自动退出（启动前 10 分钟为宽限期）。日志：`~/.pi/agent/feishu-bridge/gateway.log`。

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
