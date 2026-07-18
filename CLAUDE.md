# focus-timer-tools — agent guide

Public tooling repo for Focus: CLI (`cli/`), MCP (`mcp/`), memory ETL client + contracts
(`memory/`), ops scripts (`scripts/`), and the `focus-timer` skill (`skills/`). The Convex backend
lives in the private repo `jpvarbed/focus-timer`; everything here talks to its deployment over the
keyed `/agent/*` HTTP layer.

## Testing ladder

1. `bun test` — unit + contract tests. Offline, no key needed.
2. `bun run smoke` — end-to-end against a **real deployment** (`scripts/smoke-memory.ts`): the
   deployed HTTP router, real bearer-key auth, real full-text search, and the actual
   `FocusHttpClient` (zod contracts, transport limits, scope checks). Flow: watermark →
   `decision.create` marker → exact-envelope replay dedup → stored receipt → search hit →
   `decision.tombstone` → search empty. Self-cleaning — all writes are confined to the reserved
   scope `smoke.invalid/focus/memory` and tombstoned by the same run — so it is safe against prod.
   Env: `FOCUS_API_KEY` (required), `FOCUS_CONVEX_SITE` (defaults to prod).
   Run it after touching `memory/` contracts or transport, and after any backend deploy.
3. CI (`.github/workflows/post-merge-smoke.yml`) runs both on every push to main, after the
   hosted-MCP Vercel deploy that a merge triggers.

## Cross-repo contract pins

`tests/fixtures/memory-contract/*` are byte-identical copies of the backend's
`packages/backend/testFixtures/memoryContract/*`, pinned by SHA-256 in both repos' tests. Any
wire-contract change must update both copies and both pins together, and should finish with
`bun run smoke` against a deployment.
