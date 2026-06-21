# focus-timer-tools

Headless clients for the **[focus.jasonv.dev](https://focus.jasonv.dev)** Pomodoro timer — a
**CLI**, an **MCP server**, and a **Claude skill**. The timer is *server-owned*: your browser,
this CLI, an MCP-connected agent, and the skill all drive **one coherent timer** (25-min focus /
5-min break, long break every 4th, auto-advancing server-side).

The app itself (web + Convex backend) lives in a separate private repo. These tools talk to its
public Convex deployment.

## Install the skill

```bash
npx skills add jpvarbed/focus-timer-tools
```

Installs the `focus-timer` skill (`skills/focus-timer/SKILL.md`) into your agent.

## Identity

Set `FOCUS_USER_ID` to your account id to drive *your* timer — copy it from the web app
(devtools → Application → Cookies → `focus_user_id`). Any stable value works for a fresh,
separate timer. The endpoint defaults to the focus.jasonv.dev deployment; override with
`CONVEX_URL`.

## CLI

```bash
FOCUS_USER_ID=<your-id> bun run cli/src/index.ts status
# status · start [label] · pause · resume · skip · reset · stats · watch
```

## MCP server

Add to your MCP client (Claude Desktop/Code):

```json
{
  "mcpServers": {
    "focus-timer": {
      "command": "bun",
      "args": ["run", "/path/to/focus-timer-tools/mcp/src/stdio.ts"],
      "env": { "FOCUS_USER_ID": "<your-id>" }
    }
  }
}
```

Tools: `focus_status`, `focus_start`, `focus_pause`, `focus_resume`, `focus_skip`,
`focus_reset`, `focus_stats`.

## Claude skill

[`skills/focus-timer/SKILL.md`](skills/focus-timer/SKILL.md) — installed via `npx skills add`
above (or drop into your skills dir). Wraps the CLI so an agent can pace its own work in focus
blocks.
