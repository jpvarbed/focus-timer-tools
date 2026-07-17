import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LoadBatchSchema, LoadReceiptSchema } from "../memory/contracts";
import { verifyReceiptMatchesBatch } from "../memory/pipeline";

// The same fixture bytes are committed in focus-timer
// (packages/backend/testFixtures/memoryContract/), where an integration test proves the
// real HTTP router produces exactly this receipt shape for exactly this batch. The SHA-256
// pins keep the two copies from drifting apart silently; update both copies and both
// pinned hashes together.
const BATCH_FIXTURE_SHA256 = "b933557997934b33c481f0c4e87097b66cccf9000b2582d648258e17999a1bc1";
const RECEIPT_FIXTURE_SHA256 = "9b8248aec81dd5c411a95fce1632ee4915777b4cd340704aae476f189f2a1caa";

function fixture(name: string): { raw: string; value: unknown } {
  const raw = readFileSync(path.join(import.meta.dir, "fixtures", "memory-contract", name), "utf8");
  return { raw, value: JSON.parse(raw) };
}
const batchFixture = fixture("load-batch.decision-create.v1.json");
const receiptFixture = fixture("load-receipt.decision-create.v1.json");

describe("cross-repo memory contract fixtures", () => {
  test("fixture bytes match the cross-repo pins", () => {
    expect(createHash("sha256").update(batchFixture.raw).digest("hex")).toBe(BATCH_FIXTURE_SHA256);
    expect(createHash("sha256").update(receiptFixture.raw).digest("hex")).toBe(RECEIPT_FIXTURE_SHA256);
  });

  test("the client's strict schemas accept the exact fixture bytes", () => {
    const batch = LoadBatchSchema.parse(batchFixture.value);
    const receipt = LoadReceiptSchema.parse(receiptFixture.value);
    expect(() => verifyReceiptMatchesBatch(batch, receipt)).not.toThrow();
  });

  test("an unknown server field is a contract break, not something the client ignores", () => {
    const widened = { ...(receiptFixture.value as Record<string, unknown>), serverExtra: true };
    expect(() => LoadReceiptSchema.parse(widened)).toThrow();
  });
});
