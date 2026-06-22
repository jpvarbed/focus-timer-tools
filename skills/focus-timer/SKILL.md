---
name: focus-timer
description: Control the server-owned Pomodoro timer AND report into the attention-orchestrator fleet (focus.jasonv.dev) — start/check/pace a focus timer, and report agent presence, raise asks for the human, or record provenance events. Use when the user wants to start a focus session or check time, or when an agent should report its status to Jason's fleet, ask him a question, or log a decision/output.
---

# Focus Timer

Control the shared, server-owned focus timer. The session lives in Convex, so the web app,
this skill, and any other client all see and control **one** timer. A scheduled function
advances phases automatically (25-min focus → 5-min break, 15-min long break every 4th) —
even when nothing is watching.

## Setup

Set `FOCUS_USER_ID` to your account id (data is scoped per user). To control the **same** timer
as the web app, copy the web's `focus_user_id` cookie; otherwise any stable id starts a separate
timer. The endpoint defaults to focus.jasonv.dev (override with `CONVEX_URL`).

```bash
export FOCUS_USER_ID="<your-user-id>"
bun run cli/src/index.ts <command>     # from this repo (focus-timer-tools)
```

Or connect the **MCP server** — either the hosted one at `https://mcp.jasonv.dev/api/mcp`
(pass your account id in the `x-focus-user` header) or local stdio (`mcp/src/stdio.ts`). Tools:
timer (`focus_status`, `focus_start`, `focus_pause`, `focus_resume`, `focus_skip`, `focus_reset`,
`focus_stats`) **and fleet** (`focus_report`, `focus_ask`, `focus_event`, `focus_fleet`).

## Commands

| Command | Does |
|---------|------|
| `focus status` | current phase, time remaining, status, cycle |
| `focus start [label]` | start a focus session (optional task label) |
| `focus pause` / `focus resume` | pause / resume |
| `focus skip` | end the current phase now (advance to the next) |
| `focus reset` | stop and clear (back to idle) |
| `focus stats` | today's completed-focus count + total minutes |
| `focus config focus=25 short=5 long=15 interval=4 autostart=true` | update settings |
| `focus watch` | live countdown (realtime) — useful while pacing work |

## Using it to pace your own work (agents)

When the user asks you to "work in focus blocks" or to time a task:

1. `focus start "<what you're working on>"` at the beginning of a work block.
2. Periodically `focus status`; when the phase flips to a break, **stop and report progress**
   rather than starting new deep work — the break is the cue to checkpoint.
3. On resume, `focus status` to confirm you're back in a focus phase, then continue.
4. At the end, `focus stats` to report how many focus blocks the task took.

Keep the label specific (what you're actually doing) so `focus stats` is meaningful later.

## Reporting into the fleet (attention orchestrator)

Jason runs many agents across projects; the fleet is how he sees who's working, who needs him,
and what each agent decided. When you're an agent working on his behalf:

| Command / tool | Does |
|---|---|
| `focus fleet` / `focus_fleet` | show the fleet — agents by project/task + open asks |
| `focus report agent=<id> project=<p> [state=working\|needs_you\|done] [task=<title>]` / `focus_report` | report your presence; `task` groups 2+ agents on one workstream |
| `focus ask agent=<id> [severity=soft\|hard] "question"` / `focus_ask` | ask Jason a question. **soft** = can wait (held during his focus block, surfaces at his break); **hard** = you're blocked, pierces now |
| `focus_event` (MCP) | record a provenance event (`decision`/`output`/…); for a decision, cite knowledge via `refs: [{type:'informs', target:'knowledge:<id>'}]` |

Guidance: `report` `working` when you pick up a task and `done` when you finish; raise a `soft`
ask for anything that can wait for his break, `hard` only when you genuinely can't proceed. Log a
`focus_event` `decision` (with a knowledge ref) at real forks so the work is traceable.

## Notes

- The timer is **shared**: if the user starts/pauses it in the web app, your `focus status`
  reflects that within moments (realtime). Don't assume you're the only controller.
- `focus skip` mid-focus logs only the elapsed time, not a full session.
