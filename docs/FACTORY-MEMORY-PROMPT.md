ROLE: executor
DELEGATION_DEPTH: 1
WORK_UNIT: 9df3803b-2388-4890-b1a3-ed94330ce98d
Do not redispatch this same work unit. Return exact repo/worktree paths and verification receipts to the steward.

Implement the approved plan at:

`/Users/jasonvarbedian/dev/focus-timer/docs/plans/2026-07-16-focus-decision-memory.md`

Repositories in scope, and no others:

- `/Users/jasonvarbedian/dev/focus-timer`
- `/Users/jasonvarbedian/dev/focus-timer-tools`

The existing changes in both working trees are steward-owned baseline/plan work. Preserve them.

Execute the local work end to end with TDD. Build the collector → deterministic ETL → Focus Convex loader/decision lifecycle vertical slice, remove Gemini from the operational knowledge path using the approved title/body full-text design, propagate the contract through HTTP/CLI/local MCP/hosted read MCP/docs/skill, and add the Neo4j projection code and pure tests. Use the official stable MCP SDK already installed. Reuse the prototype behavior from `/Users/jasonvarbedian/dev/agent-memory` as reference; do not create a second persistence system or global MCP.

Hard boundaries:

- Do not commit, push, deploy, publish, mutate global client configuration, or access Bitwarden/secrets.
- Do not call any Gemini model/API or introduce any model fallback.
- Do not modify files outside the two scoped repositories.
- Do not use destructive Git commands or discard steward/user changes.
- Do not claim live Focus/Neo4j verification; deployment is separately gated.
- Do not weaken or delete tests to get green.

Required receipts:

- Show red-before-green for each behavior slice and the named production mutation checks.
- Run both repositories' root build/test commands and `git diff --check`.
- Run the no-Google runtime test with a planted failing canary and then green.
- Write `/Users/jasonvarbedian/dev/focus-timer-tools/docs/FACTORY-MEMORY-RESULT.md` with wall time, commands, exact test counts, remaining limitations, and every file changed.
- End with a concise factual summary; Droid's summary is not acceptance evidence.
