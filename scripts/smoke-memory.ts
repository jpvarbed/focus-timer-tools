#!/usr/bin/env bun
/**
 * smoke-memory — end-to-end smoke of the decision-memory path against a REAL deployment.
 *
 * convex-test covers the logic but simulates the runtime; this exercises what it can't: the
 * deployed HTTP router, the real bearer-key flow, real full-text search ranking, and the actual
 * FocusHttpClient (zod contracts, transport limits, scope checks) — the same code every tool uses.
 *
 * Flow: watermark → decision.create (unique marker) → exact replay (must dedup) → stored receipt →
 * search finds the marker → decision.tombstone → search comes back empty. Every write is scoped to
 * repository "smoke.invalid/focus/memory" and tombstoned on the way out, so no real scope is touched and
 * nothing stays active — safe to point at prod after a deploy.
 *
 * Env: FOCUS_API_KEY (required) · FOCUS_CONVEX_SITE (defaults to the prod .convex.site).
 * Usage: bun scripts/smoke-memory.ts
 */
import { FocusHttpClient } from "../memory/client";
import { canonicalJson, sha256, type LoadBatch, type LoadOperation } from "../memory/contracts";

const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";
const FOCUS_KEY = process.env.FOCUS_API_KEY ?? "";
if (!FOCUS_KEY) {
  console.error("Set FOCUS_API_KEY (focus web → Settings → Mint key).");
  process.exit(1);
}

// Scope validation requires a canonical host/owner/repo id; .invalid is the RFC 2606 reserved
// TLD, so this scope can never collide with a real repository.
const REPOSITORY = "smoke.invalid/focus/memory";
const BRANCH = "main";
const marker = `smoke${sha256(`smoke-memory ${new Date().toISOString()}`).slice(0, 12)}`;

const sourceFields = {
  repository: REPOSITORY,
  branch: BRANCH,
  sourceRepoRelativePath: "scripts/smoke-memory.ts",
  sourceSha256: sha256(marker),
  sourceVersion: sha256(marker).slice(0, 40),
  lineStart: 1,
  lineEnd: 1,
  agent: "smoke",
  confirmed: true as const,
};

function batchFor(operation: LoadOperation): LoadBatch {
  const collector = { name: "file-decision", version: "1.0.0" } as const;
  const clientKey = `op_${sha256(canonicalJson(operation))}`;
  return {
    schemaVersion: 1,
    collector,
    clientKey,
    envelopeId: `env_${sha256(canonicalJson({ collector, clientKey, operations: [operation] }))}`,
    operations: [operation],
  };
}

let stepCount = 0;
function step(name: string): void {
  stepCount += 1;
  console.log(`[${stepCount}] ${name}`);
}
function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const client = new FocusHttpClient(FOCUS_SITE, FOCUS_KEY);
console.log(`smoke-memory against ${FOCUS_SITE} (scope ${REPOSITORY}, marker ${marker})`);

step("watermark resolves an owner key");
const ownerKey = await client.ownerKey();
if (!/^[0-9a-f]{64}$/.test(ownerKey)) fail(`ownerKey is not 64 hex: ${ownerKey}`);

step("decision.create loads the marker decision");
const createBatch = batchFor({
  op: "decision.create",
  ...sourceFields,
  text: `Smoke marker ${marker}: end-to-end load/read check, tombstoned by this same run.`,
});
const created = await client.load(createBatch);
if (created.replayed) fail("first load reported replayed=true");
const result = created.results[0];
if (result?.op !== "decision.create") fail(`unexpected result op: ${result?.op}`);
const { assertionId, revisionId } = result;

step("exact replay of the same envelope dedups to the same ids");
const replayed = await client.load(createBatch);
if (!replayed.replayed) fail("replay reported replayed=false");
const replayResult = replayed.results[0];
if (replayResult?.op !== "decision.create" || replayResult.assertionId !== assertionId || replayResult.revisionId !== revisionId) {
  fail("replay returned different ids");
}

step("stored receipt matches the live receipt");
const receipt = await client.receipt(createBatch.envelopeId);
if (!receipt) fail("no stored receipt for the envelope");
if (receipt.serverDigest !== created.serverDigest || receipt.clientKey !== createBatch.clientKey) {
  fail("stored receipt digest/clientKey mismatch");
}

step("full-text search finds the marker in scope");
const hits = await client.searchDecisions({ repository: REPOSITORY, branch: BRANCH, queryText: marker });
if (!hits.some((hit) => hit.assertionId === assertionId)) {
  fail(`search returned ${hits.length} hits, none with the created assertion`);
}

step("decision.tombstone retires the marker");
const tombstoned = await client.load(
  batchFor({ op: "decision.tombstone", ...sourceFields, assertionId, expectedActiveRevisionId: revisionId }),
);
const tombstoneResult = tombstoned.results[0];
if (tombstoneResult?.op !== "decision.tombstone") fail(`unexpected tombstone result op: ${tombstoneResult?.op}`);
if (tombstoneResult.currentActiveRevisionId !== null) fail("tombstone left an active revision");

step("search no longer returns the retired decision");
const after = await client.searchDecisions({ repository: REPOSITORY, branch: BRANCH, queryText: marker });
if (after.some((hit) => hit.assertionId === assertionId)) fail("tombstoned decision still active in search");

console.log(`PASS: ${stepCount} steps green against ${FOCUS_SITE}`);
