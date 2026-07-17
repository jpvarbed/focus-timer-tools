---
ROLE: steward
WORK_UNIT: 9df3803b-2388-4890-b1a3-ed94330ce98d
FACTORY_SESSION: 014ca9cd-1a7a-4ac1-a425-1407405c970f
---

# Factory Droid: Focus memory implementation result

## Outcome

Factory produced a useful but unsafe partial implementation. In 11m15s it made 129 tool calls and
completed the initial Convex decision lifecycle, no-model knowledge search, and HTTP endpoint tests.
It did not finish the requested system.

The run terminated at its usage limit while a deliberate mutation allowed request-body `userId`
to override bearer ownership. That insecure mutation remained in the working tree. The steward
detected the red ownership test, reverted the mutation, regenerated Convex bindings, and continued
the remaining work locally.

## What Droid completed

- Decision source/assertion/revision/active-projection schema and lifecycle tests.
- Confirmed create, exact replay, correction, retirement, branch/owner scope, and provenance events.
- Convex full-text knowledge path replacing the runtime model/embedding call.
- A repository-wide no-Google runtime safety test with a planted red/green canary.
- Authenticated loader/search/receipt/watermark/state HTTP routes and five bearer-layer tests.
- Conversion of the old transcript distiller from model classification to deterministic candidates.

## What required steward repair

- Revert the unreverted insecure ownership mutation left at quota termination.
- Regenerate checked-in Convex API bindings; Factory's partial tree passed tests but did not build.
- Reject non-Git 64-character source-version fallbacks.
- Bind idempotency to both envelope ID and client key.
- Add confirmed `knowledge.upsert` and `provenance.append` loader operations.
- Fix decision provenance targets so the existing graph projector can resolve them.
- Implement collectors, append-only spool, deterministic ETL, CLI, local/hosted MCP reads, fixed
  watermark Neo4j state projection, documentation, and cross-repo end-to-end tests.

## Verification receipts

- Factory collector envelope:
  `env_310bfb845ec3a65cb16f70ff23eefc33299a0e4030171d466616d8b4352e3c1e`.
  Deterministic ETL produced client key
  `op_1b8e9cd2576e97089f58ce518cfe3c2d6c459333481fa11bc7babdad4e7b0e07`
  and exactly one `provenance.append` operation. It remains pending until explicit deployment
  approval; no live loader call was made.
- Factory: 27 decision/knowledge tests green; 2 no-Google tests green; 5 HTTP tests green.
- Steward after recovery and review fixes: 132 backend tests + 2 web tests green.
- Cross-repo e2e: collector → ETL → real Convex functions → retry → branch-scoped recall →
  correction → retirement, with three immutable revisions and three provenance events.
- Tools: 46 tests green, including official MCP client discovery/call/error tests, CLI public-seam
  tests, collector/ETL/spool tests, graph projection tests, and knowledge comparison tests.
- Adversarial follow-up hardened three areas Droid never reached: receipt-to-batch binding before
  archival, Git replacement-object resistance plus checkout-independent ETL, durable no-replace
  spool publication and owner binding, HTTP origin/response validation, owner-bound graph
  projection, independent read/request budgets, and complete count/digest/lifecycle-chain
  verification for the fixed-watermark Neo4j snapshot.
- Read-only knowledge comparison: 104 live rows, 3 curated queries, 0 missed expected slugs.

## Factory evaluation

Factory is fast at breadth-first code generation and test loops. The current CLI is not safe to
leave unattended across quota boundaries: it can terminate between an intentional mutation and
its revert, leaving a security regression in the worktree. Its completion summary is not an
acceptance receipt, and quota/fallback behavior must be treated as a product constraint in the
ten-ticket pilot.

No commit, production deployment, hosted MCP publication, or global configuration change occurred
in this run. The steward's later `convex codegen` command uploaded functions to the configured
development deployment while generating checked-in bindings; no `convex deploy` command ran.
