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
