import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  makeEnvelope,
  parseFactoryReceipt,
  type DecisionAction,
  type DecisionRaw,
  type FactoryRunEnvelope,
  type FileDecisionEnvelope,
  type MemoryEnvelopeContent,
} from "./contracts";
import { deriveCitation } from "./gitSource";
import { spoolEnvelope } from "./spool";
import { MAX_TRANSPORT_BYTES } from "./policy";

function requireConfirmed(confirmed: boolean): asserts confirmed is true {
  if (confirmed !== true) throw new Error("collector requires explicit confirmation");
}

function decisionRaw(input: {
  action: DecisionAction;
  text?: string;
  assertionId?: string;
  expectedActiveRevisionId?: string;
}): DecisionRaw {
  const text = input.text?.trim();
  const assertionId = input.assertionId?.trim();
  const expectedActiveRevisionId = input.expectedActiveRevisionId?.trim();
  switch (input.action) {
    case "create":
      if (!text) throw new Error("decision text is required");
      if (assertionId || expectedActiveRevisionId) throw new Error("create does not accept prior revision IDs");
      return { action: "create", text };
    case "correct":
      if (!text) throw new Error("decision text is required");
      if (!assertionId || !expectedActiveRevisionId) {
        throw new Error("correction/retirement requires assertionId and expectedActiveRevisionId from a receipt");
      }
      return { action: "correct", text, assertionId, expectedActiveRevisionId };
    case "tombstone":
      if (text) throw new Error("tombstone does not accept decision text");
      if (!assertionId || !expectedActiveRevisionId) {
        throw new Error("correction/retirement requires assertionId and expectedActiveRevisionId from a receipt");
      }
      return { action: "tombstone", assertionId, expectedActiveRevisionId };
  }
}

export async function collectFileDecision(input: {
  cwd: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  action: DecisionAction;
  text?: string;
  assertionId?: string;
  expectedActiveRevisionId?: string;
  actor: string;
  project?: string;
  confirmed: boolean;
  observedAt?: string;
  spoolRoot?: string;
}): Promise<FileDecisionEnvelope> {
  requireConfirmed(input.confirmed);
  const actor = input.actor.trim();
  if (!actor) throw new Error("actor is required");
  const raw = decisionRaw(input);
  const { citation, repositoryRoot, absolutePath } = await deriveCitation(
    input.cwd,
    input.file,
    input.lineStart,
    input.lineEnd,
  );
  const content = {
    schemaVersion: 1 as const,
    kind: "file-decision" as const,
    observedAt: input.observedAt ?? new Date().toISOString(),
    collector: { name: "file-decision" as const, version: "1.0.0" as const },
    actor,
    ...(input.project ? { project: input.project } : {}),
    confirmed: true as const,
    source: citation,
    sourceLocator: { kind: "repo-file" as const, repositoryRoot, absolutePath },
    raw,
  } satisfies MemoryEnvelopeContent;
  const envelope = makeEnvelope(content);
  spoolEnvelope(envelope, input.spoolRoot);
  return envelope;
}

export async function collectFactoryRun(input: {
  receiptPath: string;
  actor: string;
  project?: string;
  confirmed: boolean;
  observedAt?: string;
  spoolRoot?: string;
}): Promise<FactoryRunEnvelope> {
  requireConfirmed(input.confirmed);
  const actor = input.actor.trim();
  if (!actor) throw new Error("actor is required");
  const absolutePath = realpathSync(path.resolve(input.receiptPath));
  if (statSync(absolutePath).size > MAX_TRANSPORT_BYTES) throw new Error("Factory receipt exceeds 1 MiB limit");
  const receipt = parseFactoryReceipt(JSON.parse(readFileSync(absolutePath, "utf8")) as unknown);
  const content = {
    schemaVersion: 1 as const,
    kind: "factory-run" as const,
    observedAt: input.observedAt ?? new Date().toISOString(),
    collector: { name: "factory-run" as const, version: "1.0.0" as const },
    actor,
    ...(input.project ? { project: input.project } : {}),
    confirmed: true as const,
    sourceLocator: { kind: "factory-receipt" as const, absolutePath },
    raw: receipt,
  } satisfies MemoryEnvelopeContent;
  const envelope = makeEnvelope(content);
  spoolEnvelope(envelope, input.spoolRoot);
  return envelope;
}
