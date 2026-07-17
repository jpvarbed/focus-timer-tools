import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  canonicalJson,
  LoadReceiptSchema,
  type FocusLoader,
  type LoadBatch,
  type MemoryEnvelope,
} from "./contracts";
import { transformEnvelope } from "./etl";
import { FocusHttpError } from "./client";
import {
  archiveLoaded,
  bindSpoolOwner,
  ensureSpool,
  quarantineEnvelope,
  readPendingEnvelope,
  recordAttempt,
} from "./spool";

type LeaseRecord = { pid: number; token: string; startedAt: string };

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSyncLease(root: string): () => void {
  const leaseDir = path.join(root, ".sync-lease");
  const ownerPath = path.join(leaseDir, "owner.json");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(leaseDir, { mode: 0o700 });
    } catch {
      let stale = false;
      try {
        const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LeaseRecord;
        stale = Number.isInteger(owner.pid) && !processIsAlive(owner.pid);
      } catch {
        try {
          stale = Date.now() - statSync(leaseDir).mtimeMs > 60_000;
        } catch {
          stale = false;
        }
      }
      if (!stale || attempt > 0) throw new Error("another memory sync owns the spool lease");
      const stalePath = `${leaseDir}.stale.${randomUUID()}`;
      try {
        renameSync(leaseDir, stalePath);
        rmSync(stalePath, { recursive: true, force: true });
      } catch {
        throw new Error("another memory sync owns the spool lease");
      }
      continue;
    }
    try {
      writeFileSync(
        ownerPath,
        `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() } satisfies LeaseRecord)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return () => {
        try {
          const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as LeaseRecord;
          if (owner.token === token) rmSync(leaseDir, { recursive: true, force: true });
        } catch {
          // A missing/replaced lease is not ours to remove.
        }
      };
    } catch {
      rmSync(leaseDir, { recursive: true, force: true });
      throw new Error("failed to initialize memory sync lease");
    }
  }
  throw new Error("unable to acquire memory sync lease");
}

export function verifyReceiptMatchesBatch(batch: LoadBatch, receipt: ReturnType<typeof LoadReceiptSchema.parse>): void {
  const mismatch = (message: string): never => { throw new ReceiptMismatchError(message); };
  if (receipt.envelopeId !== batch.envelopeId) mismatch("server receipt envelopeId mismatch");
  if (receipt.clientKey !== batch.clientKey) mismatch("server receipt clientKey mismatch");
  if (canonicalJson(receipt.collector) !== canonicalJson(batch.collector)) {
    mismatch("server receipt collector mismatch");
  }
  if (receipt.results.length !== batch.operations.length) {
    mismatch("server receipt result count does not match submitted operations");
  }
  for (let index = 0; index < batch.operations.length; index += 1) {
    if (receipt.results[index]!.op !== batch.operations[index]!.op) {
      mismatch(`server receipt operation ${index} does not match submitted batch`);
    }
    const operation = batch.operations[index]!;
    const operationResult = receipt.results[index]!;
    if (operation.op === "decision.correct" || operation.op === "decision.tombstone") {
      if (!("assertionId" in operationResult) || operationResult.assertionId !== operation.assertionId) {
        mismatch(`server receipt assertion ${index} does not match submitted batch`);
      }
    }
    if (operationResult.op === "decision.create" || operationResult.op === "decision.correct") {
      if (operationResult.currentActiveRevisionId !== operationResult.revisionId) {
        mismatch(`server receipt active revision ${index} does not match created revision`);
      }
    }
    if (operationResult.op === "decision.tombstone" && operationResult.currentActiveRevisionId !== null) {
      mismatch(`server receipt tombstone ${index} left an active revision`);
    }
  }
  const expectedEventCount = batch.operations.length;
  if (receipt.provenanceEventIds.length !== expectedEventCount) {
    mismatch("server receipt provenance count does not match submitted operations");
  }
  if (new Set(receipt.provenanceEventIds).size !== receipt.provenanceEventIds.length) {
    mismatch("server receipt contains duplicate provenance event ids");
  }
  for (const result of receipt.results) {
    if (result.op === "provenance.append" && !receipt.provenanceEventIds.includes(result.eventId)) {
      mismatch("server receipt provenance result is not present in provenanceEventIds");
    }
  }
}

export class ReceiptMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptMismatchError";
  }
}

function isPermanentLoadFailure(error: unknown): boolean {
  return error instanceof FocusHttpError &&
      error.status >= 400 &&
      error.status < 500 &&
      ![401, 403, 404, 408, 425, 429].includes(error.status);
}

export async function syncPending(input: { spoolRoot?: string; loader: FocusLoader; bindOwner?: boolean }) {
  const result = { loaded: 0, failed: 0, quarantined: 0 };
  const dirs = ensureSpool(input.spoolRoot);
  const releaseLease = acquireSyncLease(dirs.root);
  try {
    const ownerKey = await input.loader.ownerKey();
    bindSpoolOwner(input.spoolRoot, ownerKey, input.bindOwner === true);
    const names = readdirSync(dirs.pending).filter((name) => /^env_[0-9a-f]{64}\.json$/.test(name)).sort();
    for (const name of names) {
      const pendingPath = path.join(dirs.pending, name);
      let envelope: MemoryEnvelope;
      try {
        envelope = readPendingEnvelope(pendingPath, name);
      } catch (error) {
        const envelopeId = name.replace(/\.json$/, "");
        try {
          quarantineEnvelope(input.spoolRoot, pendingPath, envelopeId, error as Error);
          result.quarantined += 1;
        } catch (quarantineError) {
          recordAttempt(input.spoolRoot, envelopeId, quarantineError as Error);
          result.failed += 1;
        }
        continue;
      }
      let batch: LoadBatch;
      try {
        batch = await transformEnvelope(envelope);
      } catch (error) {
        quarantineEnvelope(input.spoolRoot, pendingPath, envelope.envelopeId, error as Error);
        result.quarantined += 1;
        continue;
      }
      try {
        const receipt = LoadReceiptSchema.parse(await input.loader.load(batch));
        verifyReceiptMatchesBatch(batch, receipt);
        archiveLoaded(input.spoolRoot, pendingPath, envelope, receipt, ownerKey);
        result.loaded += 1;
      } catch (error) {
        if (isPermanentLoadFailure(error)) {
          quarantineEnvelope(input.spoolRoot, pendingPath, envelope.envelopeId, error as Error);
          result.quarantined += 1;
        } else {
          recordAttempt(input.spoolRoot, envelope.envelopeId, error as Error);
          result.failed += 1;
        }
      }
    }
  } finally {
    releaseLease();
  }
  return result;
}
