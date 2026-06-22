# scripts

## `cc-fleet-hook.py` — Claude Code auto-report (FOC-12)

Makes local Claude Code sessions report into the focus fleet automatically — no per-agent effort.
The harness fires the hook; the script maps the CC lifecycle to fleet presence:

| CC event | Fleet state |
|---|---|
| `SessionStart`, `UserPromptSubmit` | `working` |
| `Notification` (CC is waiting on you) | `needs_you` |
| `Stop`, `SubagentStop` | `done` |

`cwd` → project (basename), `session_id` → agent id. It never blocks or fails Claude Code (no
`FOCUS_USER_ID` → no-op; all errors swallowed; 3s timeout; always exits 0).

### Install

1. Set your identity (same id as the web app — its `focus_user_id` cookie) so the fleet is *yours*:

   ```bash
   export FOCUS_USER_ID="<your-focus-user-id>"      # add to your shell profile
   # optional: export FOCUS_CONVEX_URL=...           # defaults to prod
   ```

2. Add the hooks to `~/.claude/settings.json` (adjust the path to this repo):

   ```json
   {
     "hooks": {
       "SessionStart":     [{ "hooks": [{ "type": "command", "command": "~/dev/focus-timer-tools/scripts/cc-fleet-hook.py SessionStart" }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "~/dev/focus-timer-tools/scripts/cc-fleet-hook.py UserPromptSubmit" }] }],
       "Notification":     [{ "hooks": [{ "type": "command", "command": "~/dev/focus-timer-tools/scripts/cc-fleet-hook.py Notification" }] }],
       "Stop":             [{ "hooks": [{ "type": "command", "command": "~/dev/focus-timer-tools/scripts/cc-fleet-hook.py Stop" }] }],
       "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "~/dev/focus-timer-tools/scripts/cc-fleet-hook.py SubagentStop" }] }]
     }
   }
   ```

3. New Claude Code sessions now appear on `focus.jasonv.dev` automatically. Verify:

   ```bash
   FOCUS_USER_ID="<id>" bun ../cli/src/index.ts fleet
   ```

Semantic reporting (asks with text, decisions/provenance) stays explicit via the MCP/CLI
(`focus_ask`, `focus_event`) — hooks only cover automatic presence. Python 3 only (stdlib).

## `graph.ts` — Neo4j graph brain (FOC-14 / slice 4)

Projects the Convex provenance log into Neo4j (Aura) and queries it. Convex is the source of
truth; Neo4j is a read-side projection (batch, idempotent `MERGE`). Convex can't open Bolt, so
this runs externally.

```bash
# env (fetch from bws): NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD, FOCUS_USER_ID [, CONVEX_URL]
bun scripts/graph.ts sync                 # project Convex -> Neo4j
bun scripts/graph.ts stats                # node/edge counts
bun scripts/graph.ts knowledge <slug>     # (c) which decisions cited a concept
bun scripts/graph.ts lineage <ref>        # (c) what fed a ref (slug | commit sha | file path)
bun scripts/graph.ts patterns             # (d) orphan tasks + most-cited knowledge
```

Node types: `Project Task Agent Knowledge Event Commit File`. Edges: structural
(`CONTAINS ON WORKS_IN MADE`) + typed provenance refs (`INFORMS PRODUCES LANDS_IN …`). Run
`sync` on a cron to keep the brain fresh. AuraDB Free auto-pauses after 72h idle — resume via
the aura provisioning skill. Aura instance creds live in bws (`NEO4J_*`, `AURA_INSTANCE_ID`).

