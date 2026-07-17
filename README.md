# focus-timer-tools

Headless clients for the **[focus.jasonv.dev](https://focus.jasonv.dev)** Pomodoro timer — a
**CLI**, an **MCP server**, and a **Claude skill**. The timer is *server-owned*: your browser,
this CLI, an MCP-connected agent, and the skill all drive **one coherent timer** (25-min focus /
5-min break, long break every 4th, auto-advancing server-side).

The app itself (web + Convex backend) lives in a separate private repo. These tools talk to its
public Convex deployment.

> **New here?** Follow **[GETTING_STARTED.md](GETTING_STARTED.md)** — sign in, mint a key, and wire
> your agents in ~5 minutes. Then **[EXO_BRAIN.md](EXO_BRAIN.md)** — what to actually capture so the
> provenance graph is worth querying later.

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

The owner is derived from the key server-side (no cleartext id), access is scoped to that owner's
Focus reads and writes, and the key is one-click revocable. The endpoint defaults to the prod deployment; override with
`FOCUS_CONVEX_SITE` only if you run your own backend.

## CLI

```bash
FOC=cli/src/index.ts
bun run "$FOC" status
# timer:  status · start [label] · pause · resume · skip · reset · stats · watch · config
# fleet:  fleet · report · ask · recall · learn · decide
# memory: collect decision|factory-run · sync · recall-decisions · collector-status · receipt
```

### Durable memory: collector → ETL → Focus

```text
Factory / Codex / Claude / repository files
                    ↓ explicit, pluggable collectors
            append-only raw envelopes
                    ↓ deterministic ETL
             authenticated Focus loader
                    ↓
              Focus Convex (truth)
                    ↓
             Neo4j (read projection)
```

```bash
# The cited file must be tracked, clean, on a named branch, with one safe origin.
bun "$FOC" collect decision file=docs/decisions.md lines=12:14 action=create \
  text="Use Focus as the durable memory home." actor=codex confirm=true
# First sync only: verify the key, then bind this spool to its opaque Focus owner.
bun "$FOC" sync bind-owner=true
# Later syncs reject a different owner automatically.
bun "$FOC" sync
bun "$FOC" recall-decisions query="durable memory"
bun "$FOC" collector-status
bun "$FOC" receipt env_<id>
```

Correction and retirement take Focus IDs from a prior receipt; ETL never guesses a target by text.
Factory receipts become provenance only, not decisions. There is no ambient transcript capture.
The configured local `origin` supplies repository identity; it is not proof that the remote host
advertises the commit. Collection proves the exact local commit/path/file hash with Git replacement
objects disabled. Later sync validates the immutable envelope instead of depending on the current
checkout, and archives it only after the server receipt matches every submitted operation. The
spool stores only an opaque owner hash in `owner.json`; an unassigned spool requires explicit
first-use binding, and a spool can never be loaded through a different Focus owner.

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

Local tools also expose `focus_collect`, `focus_sync_memory`, `focus_search_decisions`,
`focus_collector_status`, and `focus_ingest_receipt`. The hosted MCP exposes decision recall and
receipts but not a fake remote filesystem collector. Existing tools: `focus_report`, `focus_ask`,
`focus_event`, `focus_recall`, `focus_learn`, plus the timer
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
