# pi-feishu (English)

A Feishu (Lark) "remote cockpit" extension for pi sessions — turn a Feishu group into a broadcast and remote-control entry point for your pi sessions.

## Features

### Outbound Broadcast
- Sessions with `/feishu-follow on` push the AI's final reply to the Feishu group on `agent_end` (with a `[pi:session-name]` prefix)
- Pushes a "waiting for input" reminder (with question summary) when `ask_user_question` is pending
- Replies exceeding the threshold (default 2000 chars): truncated summary in group + full text written to a Feishu doc + link back to the group

### Inbound Remote Control
- `@bot <session-name> <command>` injects into the matching pi session (steer when busy, triggerTurn when idle)
- `@bot list` shows all online followed sessions
- Double-gate security: @bot mention (matched via mentions array) + open_id whitelist; empty whitelist rejects all

### Multi-session Group Control
- Single bot + name-based routing: session name defaults to cwd basename, conflicts get numeric suffixes, rename via `/feishu-name`
- Claim-file arbitration (`~/.pi/agent/feishu-bridge/claim.json`)

## Installation

```jsonc
// ~/.pi/agent/settings.json
{
  "packages": ["pi-feishu"]
}
```

## Configuration

```jsonc
// settings.json (global or project-level .pi/settings.json)
{
  "feishu": {
    "chatId": "oc_xxx",
    "whitelist": ["ou_xxx"],
    "truncateThreshold": 2000,
    "sessionName": "my-session"
  }
}
```

Credentials via environment variables:

```bash
export FEISHU_APP_ID=cli_xxx
export FEISHU_APP_SECRET=xxx
```

The extension stays silently inactive without credentials; `/feishu-follow on` will show setup instructions.

## Commands

| Command | Description |
|---------|-------------|
| `/feishu-follow on` | Claim the session: start broadcasting + become routable |
| `/feishu-follow off` | Release the session and disconnect |
| `/feishu-follow status` | Show binding status |
| `/feishu-name <name>` | Rename the session |

## Feishu App Prerequisites

1. Create a **custom app** on the open platform, enable bot capability
2. Permissions: `im:message`, `docx:document`
3. Event subscription: WebSocket mode, subscribe to `im.message.receive_v1`
4. Publish a version and add the bot to your group

## Test & Check

```bash
npm test          # vitest
npm run typecheck # tsc --noEmit (publish gate)
```
