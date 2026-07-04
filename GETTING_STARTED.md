# Getting started

Bring your own account and wire your agents into **[focus.jasonv.dev](https://focus.jasonv.dev)** —
a server-owned Pomodoro timer, an attention board for your coding agents, and a provenance graph of
the decisions they make. Everything below runs against your own account; your data is isolated from
everyone else's, and you can't be billed for anyone else's usage.

You need: [Bun](https://bun.sh) installed, and (for the auto-reporting hooks) a Claude Code setup.

---

## 1. Sign in and mint a key

1. Go to **[focus.jasonv.dev](https://focus.jasonv.dev)** and sign in with your email — one magic
   link, no password.
2. Open **Settings → API keys → Mint key**. Copy the `ak_…` key. **It's shown once.**

That key *is* your identity for agents. The owner is derived from it server-side, it's write-only to
your own fleet, and you can revoke it anytime from the same panel.

## 2. Clone the tools and install

```bash
git clone https://github.com/jpvarbed/focus-timer-tools.git ~/dev/focus-timer-tools
cd ~/dev/focus-timer-tools && bun install
```

## 3. Export your key

Put this where your agents and shell run (e.g. `~/.zshrc`, `~/.bashrc`):

```bash
export FOCUS_API_KEY=ak_your_key_here
# Optional — the CLI/MCP already default to the prod deployment:
# export FOCUS_CONVEX_SITE=https://perceptive-butterfly-406.convex.site
```

That's the only variable you need. `FOCUS_CONVEX_SITE` defaults to the live deployment, so you only
set it if you're pointing at your own backend.

## 4. Drive it from the CLI

```bash
FOC=~/dev/focus-timer-tools/cli/src/index.ts

# Timer (server-owned — stays in sync with the web app and advances on its own)
bun "$FOC" status
bun "$FOC" start "deep work"      # start · pause · resume · skip · reset · stats · watch
bun "$FOC" config focus=25 short=5 long=15 interval=4 autostart=true

# Fleet + provenance
bun "$FOC" fleet                                     # the live board
bun "$FOC" report agent=<id> project=<name> state=working task=<title>
bun "$FOC" ask    agent=<id> severity=soft "a question for later"
bun "$FOC" recall "how did we handle X"              # find prior knowledge to cite
bun "$FOC" learn  "Title" body="…" tags=a,b          # capture a concept → knowledge:<slug>
bun "$FOC" decide "what you chose" cites=knowledge:<slug>   # records the decision → knowledge lineage
```

`decide` with a `cites=` is the one thing that can't be captured automatically — it's the edge that
turns the graph from "what happened" into "why". Everything else fills itself in (below).

## 5. Auto-report — Claude Code hooks

So every session reports presence and commits **without any manual calls**, add these two hooks to
`~/.claude/settings.json`. They read `FOCUS_API_KEY` from the environment, never block Claude Code
(no key → no-op, errors swallowed, 3s timeout), and work from any repo.

```json
{
  "hooks": {
    "SessionStart":   [{ "hooks": [{ "type": "command", "command": "python3 \"$HOME/dev/focus-timer-tools/scripts/cc-fleet-hook.py\" SessionStart" }] }],
    "UserPromptSubmit":[{ "hooks": [{ "type": "command", "command": "python3 \"$HOME/dev/focus-timer-tools/scripts/cc-fleet-hook.py\" UserPromptSubmit" }] }],
    "Notification":   [{ "hooks": [{ "type": "command", "command": "python3 \"$HOME/dev/focus-timer-tools/scripts/cc-fleet-hook.py\" Notification" }] }],
    "Stop":           [{ "hooks": [{ "type": "command", "command": "python3 \"$HOME/dev/focus-timer-tools/scripts/cc-fleet-hook.py\" Stop" }] }],
    "SubagentStop":   [{ "hooks": [{ "type": "command", "command": "python3 \"$HOME/dev/focus-timer-tools/scripts/cc-fleet-hook.py\" SubagentStop" }] }],
    "PostToolUse":    [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "python3 \"$HOME/dev/focus-timer-tools/scripts/cc-commit-hook.py\"" }] }]
  }
}
```

- **`cc-fleet-hook.py`** — presence: session start / each prompt → `working`, a notification →
  `needs_you`, stop → `done`.
- **`cc-commit-hook.py`** — on any `git commit` (matched on Bash tool use), posts the commit and the
  files it touched, resolving the repo from the command's `-C`/`cd` or the cwd.

Settings are read when a session **starts**, so restart Claude Code after editing. Already have a
`hooks` block? Merge these entries into it rather than replacing it.

> **GUI apps** (the Claude desktop app, IDE extensions) don't source your shell, so a shell `export`
> won't reach them — they'll silently skip reporting. If you use one, inject `FOCUS_API_KEY` into the
> app's environment however your OS launches it (on macOS, `launchctl setenv` from a LaunchAgent), then
> relaunch the app.

## 6. MCP (optional)

Prefer to give an agent the tools directly?

**Local (stdio):**

```json
{
  "mcpServers": {
    "focus-timer": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/focus-timer-tools/mcp/src/stdio.ts"],
      "env": { "FOCUS_API_KEY": "ak_your_key_here" }
    }
  }
}
```

**Hosted:** point your MCP client at `https://mcp.jasonv.dev/api/mcp` and send
`Authorization: Bearer ak_…`. Tools: `focus_report`, `focus_ask`, `focus_event`, `focus_recall`,
`focus_learn` (+ timer tools).

## 7. Explore the graph

Your decisions, events, learned concepts, and commits link into a knowledge graph. Open the
**[Fleet Provenance Explorer](https://fleet-explorer.jasonv.app)** and connect with your
`FOCUS_API_KEY` — it reads your data live through the keyed API, so it never needs database
credentials.

New to the idea? **[Build your exo-brain](EXO_BRAIN.md)** explains each node type and the one habit —
citing decisions to the knowledge behind them — that decides whether the graph is worth querying later.

---

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Commands 401 or silently do nothing | `FOCUS_API_KEY` is unset or invalid. Re-export it, or mint a fresh key and revoke the old one. |
| `bun "$FOC" …`: module not found | Clone the repo and run `bun install` once (step 2). |
| Hooks don't fire | Settings are read at session start — restart Claude Code. Confirm `FOCUS_API_KEY` is exported in the environment that launches it. |
| Desktop/IDE app reports nothing | GUI apps don't inherit your shell env — inject `FOCUS_API_KEY` into the app's launch environment and relaunch (see step 5). |
| Explorer blank | Reconnect and paste your key; hard-refresh if it's cached. |

Rate limits are per account (a tight cap on embedding calls, ~100/hr, and 25 active keys) so an
open account can't run up a bill — well above normal use, but there if you loop.
