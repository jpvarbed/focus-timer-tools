---
name: focus-timer
description: Report into Jason's cross-project agent fleet — presence, asks, decisions, knowledge — and explore the provenance graph it builds (focus.jasonv.dev). Use when an agent should report in, flag it needs Jason, or log a decision/concept, or when Jason wants to see the fleet or explore the knowledge graph. Works from ANY project; CLI + MCP + hooks are global. Not for env/dotfiles status — use `env-status-board`.
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
write-only to the owner's fleet + one-click revocable.

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

## 3. Auto-report (no manual calls) — CC hooks

Two hooks wire into `~/.claude/settings.json` (scripts in `~/dev/focus-timer-tools/scripts`):
- **Presence** — `cc-fleet-hook.py` (SessionStart/UserPromptSubmit→working, Notification→needs_you,
  Stop→done; sends the latest prompt as the agent's `activity`).
- **Commits** — `cc-commit-hook.py` on **PostToolUse(Bash)**: a git commit posts an `output` event
  with the commit + its files (`commit:`/`file:` refs), resolving the repo from `-C`/`cd` else cwd.
  **cwd-independent** — captures commits in any repo (the old Stop-based capture only saw cwd's repo).

Both use `FOCUS_API_KEY`, never block CC (no key → no-op, errors swallowed, 3s timeout).

## 4. Read the fleet / drive the timer

`bun "$FOC" fleet` shows the live board (keyed read, no `FOCUS_USER_ID`). The **timer control + stats**
commands (`status`/`start`/`pause`/`resume`/`skip`/`reset`/`stats`/`config`) still use the pre-auth
`FOCUS_USER_ID` model and do **not** work against the auth-gated prod deployment yet — a keyed
owner-control surface is the pending slice. Drive the timer on the web (**focus.jasonv.dev**) meanwhile.

## 5. Explore the provenance graph

The graph = Projects · Agents · Tasks · Events(decision/output) · Knowledge · Commits, linked by
`WORKS_IN / ON / CONTAINS / MADE / INFORMS / PRODUCES`. Three ways in:

- **Explorer** (visual, filters): **https://fleet-explorer.jasonv.app** — connect with `FOCUS_API_KEY`;
  reads live via the keyed `/agent/*` API, no DB creds.
- **Neo4j Aura console** (Cypher + Bloom): console.neo4j.io → instance `4ceadc9b` → **Query** /
  **Explore**. Ready-to-paste lenses in **`scripts/graph-lenses.cypher`** (lineage, most-cited
  knowledge, a concept's neighborhood, an agent's output, knowledge gaps, …).
- **CLI**: `bun scripts/graph.ts stats | patterns | knowledge <slug> | lineage <ref>` (needs
  `NEO4J_*` + `FOCUS_API_KEY`; `graph.ts sync` reprojects from Convex, auto-run every 15 min).

What creates each node: **agents/projects/activity** + **commits** → automatic (the hooks); **tasks**
→ a `report` with `task=`; **decisions** → `decide`; **knowledge** → `learn`. So the structure fills
itself; the reasoning lineage is the part you record.

## Errors

| Issue | Fix |
| --- | --- |
| Agent writes 401 / silently no-op | `FOCUS_API_KEY` unset — mint one (focus → Settings) and export it. GUI apps that miss it need the `dev.jasonv.focus-key` LaunchAgent loaded (or relaunch from a terminal that sourced `~/.zshrc`). |
| `bws` empty / key won't load | The bws token is read transiently from `~/dev/.env.local` — confirm that file holds `BWS_ACCESS_TOKEN`. |
| `bun "$FOC" …`: command/module not found | Clone `~/dev/focus-timer-tools` + `bun install` once. |
| `status`/`start`/`stats`/`config` fail | Expected — timer control isn't key-native yet (see §4). Use the web. (`fleet` works — keyed.) |
| `decide` logged as a knowledge-gap | Give a real cite: `recall` → `learn` if new → `decide "…" cites=knowledge:<slug>`. |
| Explorer blank / stale | Sign out + reconnect (deployment defaults to prod, paste your key). Hard-refresh if cached. |

## Notes

- Tooling repo (this one, public): `~/dev/focus-timer-tools`. App (web + Convex backend) is the
  separate **private** `jpvarbed/focus-timer`. Registered with ARD at
  `focus.jasonv.dev/.well-known/ai-catalog.json`.
- Convex **prod `perceptive-butterfly-406`** (auth-gated, live). Neo4j Aura `4ceadc9b`. Arize traces
  → the `claude-code` project.
