# focus-timer-tools

Headless clients for the **[focus.jasonv.dev](https://focus.jasonv.dev)** Pomodoro timer — a
**CLI**, an **MCP server**, and a **Claude skill**. The timer is *server-owned*: your browser,
this CLI, an MCP-connected agent, and the skill all drive **one coherent timer** (25-min focus /
5-min break, long break every 4th, auto-advancing server-side).

The app itself (web + Convex backend) lives in a separate private repo. These tools talk to its
public Convex deployment.

> **New here?** Follow **[GETTING_STARTED.md](GETTING_STARTED.md)** — sign in, mint a key, and wire
> your agents in ~5 minutes.

## Install the skill

```bash
npx skills add jpvarbed/focus-timer-tools
```

Installs the `focus-timer` skill (`skills/focus-timer/SKILL.md`) into your agent.

## Identity — a minted key

Sign in at [focus.jasonv.dev](https://focus.jasonv.dev), then **Settings → Mint key**, and export
the `ak_…` key:

```bash
export FOCUS_API_KEY=ak_your_key_here
```

The owner is derived from the key server-side (no cleartext id), it's write-only to your own fleet,
and it's one-click revocable. The endpoint defaults to the prod deployment; override with
`FOCUS_CONVEX_SITE` only if you run your own backend.

## CLI

```bash
FOC=cli/src/index.ts
bun run "$FOC" status
# timer:  status · start [label] · pause · resume · skip · reset · stats · watch · config
# fleet:  fleet · report · ask · recall · learn · decide
```

## MCP server

Add to your MCP client (Claude Desktop/Code):

```json
{
  "mcpServers": {
    "focus-timer": {
      "command": "bun",
      "args": ["run", "/path/to/focus-timer-tools/mcp/src/stdio.ts"],
      "env": { "FOCUS_API_KEY": "ak_your_key_here" }
    }
  }
}
```

Tools: `focus_report`, `focus_ask`, `focus_event`, `focus_recall`, `focus_learn`, plus the timer
tools (`focus_status`, `focus_start`, `focus_pause`, `focus_resume`, `focus_skip`, `focus_reset`,
`focus_stats`).

**Hosted (remote) MCP:** `https://mcp.jasonv.dev/api/mcp` — authenticate with `Authorization: Bearer
ak_…`. Advertised for agentic discovery at
[focus.jasonv.dev/.well-known/ai-catalog.json](https://focus.jasonv.dev/.well-known/ai-catalog.json) (ARD).

## Auto-report — Claude Code hooks

Two hooks make every session report presence and commits with no manual calls — see
[GETTING_STARTED.md §5](GETTING_STARTED.md#5-auto-report--claude-code-hooks) for the
`~/.claude/settings.json` block (`scripts/cc-fleet-hook.py` + `scripts/cc-commit-hook.py`).

## Claude skill

[`skills/focus-timer/SKILL.md`](skills/focus-timer/SKILL.md) — installed via `npx skills add`
above (or drop into your skills dir). Wraps the CLI so an agent can pace its own work in focus
blocks and report into the fleet.
