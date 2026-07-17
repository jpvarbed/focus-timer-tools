---
name: focus-timer
description: Report into Jason's cross-project agent fleet, collect source-cited durable decisions into Focus, recall repository memory, and explore its Neo4j read projection. Use for agent presence/asks, explicit decision capture/correction/retirement, prior-memory recall, or graph exploration. Works from any Git project through the global CLI + MCP. Not for env/dotfiles status — use `env-status-board`.
---

# Focus — attention orchestrator + provenance graph

Jason runs many agents across projects. The **fleet** (on `focus.jasonv.dev`) is how he sees who's
working, who needs him, and what each agent decided. Agents report presence/asks/decisions; a Neo4j
graph projects it into a provenance web (decisions → the knowledge that informed them). This is the
single-source skill; it lives in the public tooling repo `~/dev/focus-timer-tools` (github
`jpvarbed/focus-timer-tools`) and drives its CLI + MCP.

**Announce at start:** "Using focus-timer to report to the fleet." (or "to explore the graph.")

## 1. Auth — a minted key

Agent writes authenticate with **`FOCUS_API_KEY`** — a minted `ak_…` key (focus web → Settings →
Mint key). The owner is derived from the key server-side; no cleartext id is carried, and the key is
scoped to the owner's Focus reads and writes + one-click revocable.

```bash
export FOCUS_API_KEY=$(bws secret list -o json | jq -r '.[]|select(.key=="FOCUS_API_KEY")|.value' | head -1)
# Writes POST to $FOCUS_CONVEX_SITE/agent/* (defaults to the prod deployment's .convex.site).
```

On the maintainer's machine the key is already in the env (shell export + a launchd LaunchAgent for
GUI apps — GUI apps like Claude desktop don't source the shell, so keys are injected via
`launchctl setenv`; see the dotfiles `setup.sh` §4b / `focus-key-load.sh`). Elsewhere, just export it.

## 2. Report into the fleet (the main agent use)

```bash
FOC=~/dev/focus-timer-tools/cli/src/index.ts
bun "$FOC" report agent=<id> project=<name> [state=working|needs_you|done] [task=<title>]
bun "$FOC" ask    agent=<id> [severity=soft|hard] "your question for Jason"
bun "$FOC" recall "how do we anchor P4"               # find prior knowledge to cite
bun "$FOC" learn  "Title" body="…" [tags=a,b]         # capture a concept → knowledge:<slug>
bun "$FOC" decide "what you decided" cites=knowledge:<slug>[,knowledge:<slug>]   # the lineage
```
(MCP equivalent: `focus_report` / `focus_ask` / `focus_event` / `focus_recall` / `focus_learn`, hosted
at `https://mcp.jasonv.dev/api/mcp` with `Authorization: Bearer ak_…`.)

Guidance for agents:
- `report state=working` when you pick up a task, `state=done` when you finish. `task` groups 2+
  agents on one workstream.
- `ask` for anything needing Jason: **soft** = can wait (held during his focus block, surfaces at his
  break); **hard** = you're blocked, pierces now. Don't mark everything hard.
- **At a real fork, `decide`.** `recall` for prior knowledge → `learn` it if new → `decide "…"
  cites=knowledge:<slug>`. That cite is the graph's `decision —INFORMS→ knowledge` lineage — the whole
  point. A decision with no cite is logged as a knowledge-gap (recorded, not wired). **This is the one
  thing that can't be auto-captured** (reasoning can't be inferred), so it's on you to record it.

## 3. Durable decision memory

Focus/Convex is the only memory source of truth:

```text
explicit collector → append-only envelope → deterministic ETL → Focus → Neo4j read projection
```

```bash
bun "$FOC" collect decision file=<tracked-file> lines=<start>:<end> action=create \
  text="<confirmed decision>" actor=<agent-id> confirm=true
bun "$FOC" sync bind-owner=true  # first sync only, after verifying the intended API key
bun "$FOC" sync                  # later syncs enforce the stored owner binding
bun "$FOC" recall-decisions query="<terms>"
bun "$FOC" collector-status
bun "$FOC" receipt <envelope-id>
```

For `action=correct|tombstone`, pass `receipt=<prior-envelope-id>`; the CLI copies the exact
`assertionId` and active revision ID returned by Focus. Never search by text to guess a target.
Collection rejects dirty files, detached HEAD, unsafe/missing origin identity, paths outside the
repository, and invalid line ranges. Factory receipts use
`collect factory-run receipt=<json> confirm=true` and become provenance only.

MCP equivalents: `focus_collect`, `focus_sync_memory`, `focus_search_decisions`,
`focus_collector_status`, `focus_ingest_receipt`. Hosted MCP exposes recall and receipts only;
repository collection requires the local MCP.

## 4. Auto-report (no manual calls) — CC hooks

Two hooks wire into `~/.claude/settings.json` (scripts in `~/dev/focus-timer-tools/scripts`):
- **Presence** — `cc-fleet-hook.py` (SessionStart/UserPromptSubmit→working, Notification→needs_you,
  Stop→done; sends the latest prompt as the agent's `activity`).
- **Commits** — `cc-commit-hook.py` on **PostToolUse(Bash)**: a git commit posts an `output` event
  with the commit + its files (`commit:`/`file:` refs), resolving the repo from `-C`/`cd` else cwd.
  **cwd-independent** — captures commits in any repo (the old Stop-based capture only saw cwd's repo).

Both use `FOCUS_API_KEY`, never block CC (no key → no-op, errors swallowed, 3s timeout).

## 5. Read the fleet / drive the timer

The whole CLI is key-native now (FOC-33) — just `FOCUS_API_KEY`, no `FOCUS_USER_ID`:

```bash
bun "$FOC" fleet                                      # the live board (agents + open asks)
bun "$FOC" status | start [label] | pause | resume | skip | reset | stats | watch
bun "$FOC" config focus=25 short=5 long=15 interval=4 autostart=true
```

The timer is server-owned and realtime with the web app; `watch` polls it live. (Everything routes
through the keyed `/agent/*` layer — owner from the key.)

## 6. Explore the provenance graph

The graph = Projects · Agents · Tasks · Events · Knowledge · Decisions · Commits · Files, linked by
`WORKS_IN / ON / CONTAINS / MADE / INFORMS / PRODUCES`. Three ways in:

- **Explorer** (visual, filters): **https://fleet-explorer.jasonv.app** — connect with `FOCUS_API_KEY`;
  reads live via the keyed `/agent/*` API, no DB creds.
- **Neo4j Aura console** (Cypher + Bloom): console.neo4j.io → instance `4ceadc9b` → **Query** /
  **Explore**. Ready-to-paste lenses in **`scripts/graph-lenses.cypher`** (lineage, most-cited
  knowledge, a concept's neighborhood, an agent's output, knowledge gaps, …).
- **CLI**: `bun scripts/graph.ts stats | patterns | knowledge <slug> | lineage <ref>` (needs
  `NEO4J_*` + `FOCUS_API_KEY`; `graph.ts sync` reprojects from Convex, auto-run every 15 min).

What creates each node: **agents/projects/activity** + **commits** → automatic (the hooks); **tasks**
→ a `report` with `task=`; lightweight decision events → `decide`; durable Decision nodes →
the collector/ETL/Focus lifecycle; **knowledge** → `learn`. Neo4j is never a write path.

## Errors

| Issue | Fix |
| --- | --- |
| Agent writes 401 / silently no-op | `FOCUS_API_KEY` unset — mint one (focus → Settings) and export it. GUI apps that miss it need the `dev.jasonv.focus-key` LaunchAgent loaded (or relaunch from a terminal that sourced `~/.zshrc`). |
| `bws` empty / key won't load | The bws token is read transiently from `~/dev/.env.local` — confirm that file holds `BWS_ACCESS_TOKEN`. |
| `bun "$FOC" …`: command/module not found | Clone `~/dev/focus-timer-tools` + `bun install` once. |
| Any command fails with 401 | `FOCUS_API_KEY` unset/invalid — mint + export it (all commands are keyed now). |
| `decide` logged as a knowledge-gap | Give a real cite: `recall` → `learn` if new → `decide "…" cites=knowledge:<slug>`. |
| Explorer blank / stale | Sign out + reconnect (deployment defaults to prod, paste your key). Hard-refresh if cached. |

## Notes

- Tooling repo (this one, public): `~/dev/focus-timer-tools`. App (web + Convex backend) is the
  separate **private** `jpvarbed/focus-timer`. Registered with ARD at
  `focus.jasonv.dev/.well-known/ai-catalog.json`.
- Convex **prod `perceptive-butterfly-406`** (auth-gated, live). Neo4j Aura `4ceadc9b`. Arize traces
  → the `claude-code` project.
