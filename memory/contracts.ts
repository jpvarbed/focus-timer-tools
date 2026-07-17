import { createHash } from "node:crypto";
import { z } from "zod";
import { MAX_FACTORY_REASONING_CHARS, MAX_TRANSPORT_BYTES } from "./policy";

export const ENVELOPE_ID = /^env_[0-9a-f]{64}$/;
export const OWNER_KEY = /^[0-9a-f]{64}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^[0-9a-f]{40}$/;
const SourceLine = z.number().int().safe().positive().max(10_000_000);

export const SourceCitationSchema = z
  .object({
    repository: z.string().min(1).max(2048),
    branch: z.string().min(1).max(512),
    repoRelativePath: z.string().min(1).max(4096),
    sha256: z.string().regex(SHA256),
    sourceVersion: z.string().regex(GIT_OBJECT),
    lineStart: SourceLine,
    lineEnd: SourceLine,
  })
  .strict()
  .refine((value) => value.lineEnd >= value.lineStart, "lineEnd must be greater than or equal to lineStart");
export type SourceCitation = z.infer<typeof SourceCitationSchema>;

export const CollectorIdentitySchema = z
  .object({
    name: z.enum(["file-decision", "factory-run"]),
    version: z.literal("1.0.0"),
  })
  .strict();
export type CollectorIdentity = z.infer<typeof CollectorIdentitySchema>;

const EnvelopeBaseSchema = z.object({
  schemaVersion: z.literal(1),
  envelopeId: z.string().regex(ENVELOPE_ID),
  observedAt: z.string().datetime(),
  collector: CollectorIdentitySchema,
  actor: z.string().min(1).max(256),
  project: z.string().min(1).max(256).optional(),
  confirmed: z.literal(true),
});

const DecisionRawSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), text: z.string().min(1).max(32768) }).strict(),
  z
    .object({
      action: z.literal("correct"),
      text: z.string().min(1).max(32768),
      assertionId: z.string().min(1),
      expectedActiveRevisionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("tombstone"),
      assertionId: z.string().min(1),
      expectedActiveRevisionId: z.string().min(1),
    })
    .strict(),
]);
export type DecisionRaw = z.infer<typeof DecisionRawSchema>;
export type DecisionAction = DecisionRaw["action"];

export const FactoryRunReceiptSchema = z
  .object({
    sessionId: z.string().min(1).max(256),
    elapsedMs: z.number().nonnegative(),
    toolCalls: z.number().int().nonnegative(),
    correctionPrompts: z.number().int().nonnegative(),
    tests: z.array(
      z
        .object({
          command: z.string().min(1).max(32768),
          passed: z.boolean(),
          count: z.number().int().nonnegative().optional(),
        })
        .strict(),
    ).max(10_000),
    bugs: z.array(z.string().max(32768)).max(10_000),
  })
  .strict();
export type FactoryRunReceipt = z.infer<typeof FactoryRunReceiptSchema>;

const FileDecisionEnvelopeSchema = EnvelopeBaseSchema.extend({
  kind: z.literal("file-decision"),
  collector: z.object({ name: z.literal("file-decision"), version: z.literal("1.0.0") }).strict(),
  source: SourceCitationSchema,
  sourceLocator: z
    .object({ kind: z.literal("repo-file"), repositoryRoot: z.string().min(1), absolutePath: z.string().min(1) })
    .strict(),
  raw: DecisionRawSchema,
}).strict();
export type FileDecisionEnvelope = z.infer<typeof FileDecisionEnvelopeSchema>;

const FactoryRunEnvelopeSchema = EnvelopeBaseSchema.extend({
  kind: z.literal("factory-run"),
  collector: z.object({ name: z.literal("factory-run"), version: z.literal("1.0.0") }).strict(),
  sourceLocator: z
    .object({ kind: z.literal("factory-receipt"), absolutePath: z.string().min(1) })
    .strict(),
  raw: FactoryRunReceiptSchema,
}).strict();
export type FactoryRunEnvelope = z.infer<typeof FactoryRunEnvelopeSchema>;

export const MemoryEnvelopeSchema = z.discriminatedUnion("kind", [
  FileDecisionEnvelopeSchema,
  FactoryRunEnvelopeSchema,
]);
export type MemoryEnvelope = z.infer<typeof MemoryEnvelopeSchema>;
type WithoutEnvelopeId<T> = T extends unknown ? Omit<T, "envelopeId"> : never;
export type MemoryEnvelopeContent = WithoutEnvelopeId<MemoryEnvelope>;
type FileDecisionEnvelopeContent = Omit<FileDecisionEnvelope, "envelopeId">;
type FactoryRunEnvelopeContent = Omit<FactoryRunEnvelope, "envelopeId">;

const DecisionSourceFieldsSchema = z.object({
  repository: z.string().min(1).max(2048),
  branch: z.string().min(1).max(512),
  sourceRepoRelativePath: z.string().min(1).max(4096),
  sourceSha256: z.string().regex(SHA256),
  sourceVersion: z.string().regex(GIT_OBJECT),
  lineStart: SourceLine,
  lineEnd: SourceLine,
  agent: z.string().min(1).max(256),
  confirmed: z.literal(true),
});

export const LoadOperationSchema = z.discriminatedUnion("op", [
  DecisionSourceFieldsSchema.extend({ op: z.literal("decision.create"), text: z.string().min(1).max(32768) }).strict(),
  DecisionSourceFieldsSchema.extend({
    op: z.literal("decision.correct"),
    text: z.string().min(1).max(32768),
    assertionId: z.string().min(1),
    expectedActiveRevisionId: z.string().min(1),
  }).strict(),
  DecisionSourceFieldsSchema.extend({
    op: z.literal("decision.tombstone"),
    assertionId: z.string().min(1),
    expectedActiveRevisionId: z.string().min(1),
  }).strict(),
  z
    .object({
      op: z.literal("provenance.append"),
      agent: z.string().min(1).max(256),
      type: z.literal("output"),
      summary: z.string().min(1).max(512),
      reasoning: z.string().max(MAX_FACTORY_REASONING_CHARS),
      refs: z.array(z.object({ type: z.string().min(1).max(128), target: z.string().min(1).max(1024) }).strict()).max(100),
      confirmed: z.literal(true),
    })
    .strict(),
]).superRefine((operation, ctx) => {
  if ("lineStart" in operation && operation.lineEnd < operation.lineStart) {
    ctx.addIssue({ code: "custom", path: ["lineEnd"], message: "lineEnd must be greater than or equal to lineStart" });
  }
});
export type LoadOperation = z.infer<typeof LoadOperationSchema>;

export const LoadBatchSchema = z
  .object({
    schemaVersion: z.literal(1),
    collector: CollectorIdentitySchema,
    envelopeId: z.string().regex(ENVELOPE_ID),
    clientKey: z.string().regex(/^op_[0-9a-f]{64}$/),
    operations: z.array(LoadOperationSchema).min(1).max(100),
  })
  .strict()
  .superRefine((batch, ctx) => {
    if (batch.operations.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["operations"], message: "collector batches must contain exactly one operation" });
      return;
    }
    const operation = batch.operations[0]!;
    if (batch.collector.name === "file-decision" && !operation.op.startsWith("decision.")) {
      ctx.addIssue({ code: "custom", path: ["operations", 0], message: "file-decision must emit one decision operation" });
    }
    if (batch.collector.name === "factory-run" && operation.op !== "provenance.append") {
      ctx.addIssue({ code: "custom", path: ["operations", 0], message: "factory-run must emit one provenance operation" });
    }
  });
export type LoadBatch = z.infer<typeof LoadBatchSchema>;

const DecisionResultSchema = z
  .object({
    op: z.enum(["decision.create", "decision.correct", "decision.tombstone"]),
    assertionId: z.string().min(1),
    revisionId: z.string().min(1),
    currentActiveRevisionId: z.string().min(1).nullable(),
  })
  .strict();
const OperationResultSchema = z.discriminatedUnion("op", [
  DecisionResultSchema,
  z.object({ op: z.literal("knowledge.upsert"), slug: z.string(), created: z.boolean() }).strict(),
  z.object({ op: z.literal("provenance.append"), eventId: z.string().min(1) }).strict(),
]);
const AnyCollectorIdentitySchema = z.object({ name: z.string().min(1), version: z.string().min(1) }).strict();

export const LoadReceiptSchema = z
  .object({
    replayed: z.boolean(),
    schemaVersion: z.literal(1),
    collector: CollectorIdentitySchema,
    envelopeId: z.string().regex(ENVELOPE_ID),
    clientKey: z.string().regex(/^op_[0-9a-f]{64}$/),
    serverDigest: z.string().regex(SHA256),
    results: z.array(OperationResultSchema),
    provenanceEventIds: z.array(z.string().min(1)),
  })
  .strict();
export type ServerReceipt = z.infer<typeof LoadReceiptSchema>;

const StoredBatchResultSchema = LoadReceiptSchema.extend({ collector: AnyCollectorIdentitySchema });
export const StoredReceiptSchema = z
  .object({
    schemaVersion: z.literal(1),
    collector: AnyCollectorIdentitySchema,
    envelopeId: z.string().min(1),
    clientKey: z.string().min(1),
    serverDigest: z.string().regex(SHA256),
    result: StoredBatchResultSchema,
    provenanceEventIds: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const pairs: Array<[unknown, unknown, string]> = [
      [receipt.schemaVersion, receipt.result.schemaVersion, "schemaVersion"],
      [receipt.collector.name, receipt.result.collector.name, "collector.name"],
      [receipt.collector.version, receipt.result.collector.version, "collector.version"],
      [receipt.envelopeId, receipt.result.envelopeId, "envelopeId"],
      [receipt.clientKey, receipt.result.clientKey, "clientKey"],
      [receipt.serverDigest, receipt.result.serverDigest, "serverDigest"],
      [canonicalJson(receipt.provenanceEventIds), canonicalJson(receipt.result.provenanceEventIds), "provenanceEventIds"],
    ];
    for (const [outer, inner, field] of pairs) {
      if (outer !== inner) ctx.addIssue({ code: "custom", message: `stored receipt ${field} disagrees with result` });
    }
  });
export type StoredReceipt = z.infer<typeof StoredReceiptSchema>;

export const DecisionSearchHitSchema = z
  .object({
    assertionId: z.string().min(1),
    revisionId: z.string().min(1),
    text: z.string(),
    repository: z.string().min(1),
    branch: z.string().min(1),
    source: z
      .object({
        repoRelativePath: z.string().min(1),
        sha256: z.string().regex(SHA256),
        sourceVersion: z.string().regex(GIT_OBJECT),
        lineStart: SourceLine,
        lineEnd: SourceLine,
      })
      .strict()
      .refine((source) => source.lineEnd >= source.lineStart, "invalid source line range"),
  })
  .strict();
export type DecisionSearchHit = z.infer<typeof DecisionSearchHitSchema>;

export interface FocusLoader {
  ownerKey(): Promise<string>;
  load(batch: LoadBatch): Promise<ServerReceipt>;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function withoutEnvelopeId(envelope: MemoryEnvelope): unknown {
  const { envelopeId: _ignored, ...content } = envelope;
  return content;
}

export function makeEnvelope(content: FileDecisionEnvelopeContent): FileDecisionEnvelope;
export function makeEnvelope(content: FactoryRunEnvelopeContent): FactoryRunEnvelope;
export function makeEnvelope(content: MemoryEnvelopeContent): MemoryEnvelope {
  return MemoryEnvelopeSchema.parse({
    ...content,
    envelopeId: `env_${sha256(canonicalJson(content))}`,
  });
}

export function parseEnvelope(contents: string): MemoryEnvelope {
  if (Buffer.byteLength(contents) > MAX_TRANSPORT_BYTES) throw new Error("envelope exceeds 1 MiB limit");
  const value: unknown = JSON.parse(contents);
  const envelope = MemoryEnvelopeSchema.parse(value);
  const expected = `env_${sha256(canonicalJson(withoutEnvelopeId(envelope)))}`;
  if (envelope.envelopeId !== expected) throw new Error("envelope content hash does not match envelopeId");
  return envelope;
}

export function parseFactoryReceipt(value: unknown): FactoryRunReceipt {
  return FactoryRunReceiptSchema.parse(value);
}

export function requireEnvelopeId(envelopeId: string): void {
  if (!ENVELOPE_ID.test(envelopeId)) {
    throw new Error("envelope id must use the env_<64 lowercase hex> content-addressed form");
  }
}
