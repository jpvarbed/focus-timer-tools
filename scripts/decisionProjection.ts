import { createHash } from "node:crypto";
import { z } from "zod";
import { PROJECTION_WRITE_CHUNK } from "../memory/policy";

export type DecisionState = {
  assertionId: string;
  repository: string;
  branch: string;
  active: boolean;
  headRevisionId: string;
  headKind: "create" | "correct" | "tombstone";
  text: string;
  revisionCount: number;
  source: {
    repoRelativePath: string;
    sha256: string;
    sourceVersion: string;
    lineStart: number;
    lineEnd: number;
  };
};

export type DecisionEvent = {
  _id: string;
  agentId: string;
  taskId: string | null;
  ts: number;
  type: "decision";
  summary: string;
  refs: Array<{ type: string; target: string }>;
  knowledgeGap: boolean;
  memoryVersion: number;
  assertionId: string;
  revisionId: string;
  action: "create" | "correct" | "tombstone";
  previousRevisionId: string | null;
};

export type DecisionSnapshot = {
  watermark: number;
  assertionCount: number;
  ownerKey: string;
  digest: string;
  assertions: DecisionState[];
  events: DecisionEvent[];
};

type KeyedGet = <T>(path: string) => Promise<T>;

export async function loadProjectionFeed<T>(
  get: KeyedGet,
  pathName: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const path = pathName + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const page = z.object({ items: z.array(schema), nextCursor: z.string().min(1).nullable() }).strict()
      .parse(await get<unknown>(path));
    items.push(...page.items);
    if (items.length > 1_000_000) throw new Error(`${pathName} projection exceeds 1000000 rows`);
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error(`${pathName} pagination cursor repeated`);
      seenCursors.add(cursor);
    }
  } while (cursor);
  return items;
}

const SafeInteger = z.number().int().safe();
const DecisionStateSchema = z
  .object({
    assertionId: z.string().min(1),
    repository: z.string().min(1),
    branch: z.string().min(1),
    active: z.boolean(),
    headRevisionId: z.string().min(1),
    headKind: z.enum(["create", "correct", "tombstone"]),
    text: z.string(),
    revisionCount: SafeInteger.positive(),
    source: z
      .object({
        repoRelativePath: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        sourceVersion: z.string().regex(/^[0-9a-f]{40}$/),
        lineStart: SafeInteger.positive(),
        lineEnd: SafeInteger.positive(),
      })
      .strict()
      .refine((source) => source.lineEnd >= source.lineStart, "invalid source line range"),
  })
  .strict();
const DecisionEventSchema = z
  .object({
    _id: z.string().min(1),
    agentId: z.string().min(1),
    taskId: z.string().min(1).nullable(),
    ts: SafeInteger.nonnegative(),
    type: z.literal("decision"),
    summary: z.string(),
    refs: z.array(z.object({ type: z.string().min(1), target: z.string().min(1) }).strict()),
    knowledgeGap: z.boolean(),
    memoryVersion: SafeInteger.positive(),
    assertionId: z.string().min(1),
    revisionId: z.string().min(1),
    action: z.enum(["create", "correct", "tombstone"]),
    previousRevisionId: z.string().min(1).nullable(),
  })
  .strict();
const WatermarkSchema = z
  .object({
    version: SafeInteger.nonnegative(),
    assertionCount: SafeInteger.nonnegative(),
    ownerKey: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
const StatePageSchema = z
  .object({
    asOf: SafeInteger.nonnegative(),
    assertions: z.array(DecisionStateSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();
const EventPageSchema = z
  .object({
    asOf: SafeInteger.nonnegative(),
    events: z.array(DecisionEventSchema),
    nextCursor: z.string().min(1).nullable(),
  })
  .strict();

export function fileNodeId(repository: string, repoRelativePath: string): string {
  const encode = (value: string) =>
    encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return `${encode(repository)}:${encode(repoRelativePath)}`;
}

function digestSnapshot(assertions: DecisionState[], events: DecisionEvent[]): string {
  const canonical = JSON.stringify({
    assertions: [...assertions].sort((left, right) =>
      left.assertionId < right.assertionId ? -1 : left.assertionId > right.assertionId ? 1 : 0,
    ),
    events: [...events].sort((left, right) => left.memoryVersion - right.memoryVersion),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

type DecisionPageSizes = { states?: number; events?: number };

export async function loadDecisionSnapshot(
  get: KeyedGet,
  pageSizes: DecisionPageSizes = {},
): Promise<DecisionSnapshot> {
  const limitParam = (name: keyof DecisionPageSizes) => {
    const value = pageSizes[name];
    if (value === undefined) return "";
    if (!Number.isInteger(value) || value < 1) throw new Error(`decision ${name} page size must be a positive integer`);
    return "&limit=" + encodeURIComponent(String(value));
  };
  const { version, assertionCount, ownerKey } = WatermarkSchema.parse(await get<unknown>("memory/watermark"));
  const assertions: DecisionState[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const path =
      "memory/states?asOf=" +
      encodeURIComponent(String(version)) +
      limitParam("states") +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const page = StatePageSchema.parse(await get<unknown>(path));
    if (page.asOf !== version) throw new Error("memory state page changed watermark");
    assertions.push(...page.assertions);
    if (assertions.length > 100_000) throw new Error("memory state snapshot exceeds 100000 assertions");
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("memory state pagination cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor);
  const ids = new Set(assertions.map((row) => row.assertionId));
  if (ids.size !== assertions.length) throw new Error("memory state snapshot contains duplicate assertions");
  const events: DecisionEvent[] = [];
  cursor = null;
  seenCursors.clear();
  do {
    const path =
      "memory/events?asOf=" +
      encodeURIComponent(String(version)) +
      limitParam("events") +
      (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
    const page = EventPageSchema.parse(await get<unknown>(path));
    if (page.asOf !== version) throw new Error("memory event page changed watermark");
    events.push(...page.events);
    if (events.length > 1_000_000) throw new Error("memory event snapshot exceeds 1000000 revisions");
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor)) throw new Error("memory event pagination cursor repeated");
      seenCursors.add(cursor);
    }
  } while (cursor);
  const eventIds = new Set(events.map((event) => event._id));
  if (eventIds.size !== events.length) throw new Error("memory snapshot contains duplicate lifecycle events");
  const revisionIds = new Set(events.map((event) => event.revisionId));
  if (revisionIds.size !== events.length) throw new Error("memory snapshot contains duplicate lifecycle revisions");
  if (assertions.length !== assertionCount) throw new Error("memory state snapshot count does not match watermark");
  if (events.length !== version) throw new Error("memory event snapshot count does not match watermark");
  const versions = new Set(events.map((event) => event.memoryVersion));
  if (versions.size !== version || events.some((event) => event.memoryVersion > version)) {
    throw new Error("memory lifecycle versions are incomplete or outside the watermark");
  }
  const histories = new Map<string, DecisionEvent[]>();
  for (const event of events) {
    if (!ids.has(event.assertionId)) {
      throw new Error(`memory lifecycle event references missing assertion ${event.assertionId}`);
    }
    const history = histories.get(event.assertionId) ?? [];
    history.push(event);
    histories.set(event.assertionId, history);
  }
  for (const assertion of assertions) {
    const history = histories.get(assertion.assertionId)?.sort((left, right) => left.memoryVersion - right.memoryVersion) ?? [];
    if (history.length !== assertion.revisionCount) {
      throw new Error(`memory lifecycle count does not match assertion ${assertion.assertionId}`);
    }
    for (let index = 0; index < history.length; index += 1) {
      const event = history[index]!;
      const prior = history[index - 1];
      if (index === 0 && (event.action !== "create" || event.previousRevisionId !== null)) {
        throw new Error(`memory lifecycle must begin with create for ${assertion.assertionId}`);
      }
      if (index > 0 && event.previousRevisionId !== prior!.revisionId) {
        throw new Error(`memory lifecycle chain is broken for ${assertion.assertionId}`);
      }
      if (
        (index > 0 && event.action === "create") ||
        prior?.action === "tombstone" ||
        (event.action === "tombstone" && index !== history.length - 1)
      ) {
        throw new Error(`memory lifecycle state machine is invalid for ${assertion.assertionId}`);
      }
      if (
        !event.refs.some((ref) => ref.type === "relates_to" && ref.target === `decision:${event.assertionId}`) ||
        !event.refs.some((ref) => ref.type === "relates_to" && ref.target === `revision:${event.revisionId}`) ||
        !event.refs.some((ref) => ref.type === "derived_from" && ref.target.startsWith("file:")) ||
        !event.refs.some((ref) => ref.type === "derived_from" && /^commit:[0-9a-f]{40}$/.test(ref.target)) ||
        !event.refs.some((ref) => ref.type === "derived_from" && /^blob:[0-9a-f]{64}$/.test(ref.target))
      ) {
        throw new Error(`memory lifecycle refs do not match explicit ids for ${assertion.assertionId}`);
      }
    }
    const head = history.at(-1)!;
    if (
      head.revisionId !== assertion.headRevisionId ||
      head.action !== assertion.headKind ||
      assertion.active !== (assertion.headKind !== "tombstone")
    ) {
      throw new Error(`memory head state does not match lifecycle history for ${assertion.assertionId}`);
    }
    const requiredTargets = [
      `file:${fileNodeId(assertion.repository, assertion.source.repoRelativePath)}`,
      `commit:${assertion.source.sourceVersion}`,
      `blob:${assertion.source.sha256}`,
    ];
    if (requiredTargets.some((target) => !head.refs.some((ref) => ref.type === "derived_from" && ref.target === target))) {
      throw new Error(`memory head citation does not match lifecycle event for ${assertion.assertionId}`);
    }
  }
  return { watermark: version, assertionCount, ownerKey, digest: digestSnapshot(assertions, events), assertions, events };
}

type ProjectionTransaction = {
  run(
    cypher: string,
    params?: Record<string, unknown>,
  ): Promise<{ records?: Array<{ get(key: string): unknown }> }>;
};
export const PROJECTION_SCHEMA_VERSION = 2;

export async function assertProjectionOwner(
  connection: ProjectionTransaction,
  ownerKey: string,
): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(ownerKey)) throw new Error("invalid memory projection owner key");
  const marker = await connection.run(
    "OPTIONAL MATCH (m:MemoryProjection {id: 'focus-memory'}) RETURN m.ownerKey AS ownerKey",
  );
  const currentOwner = marker.records?.[0]?.get("ownerKey");
  if (currentOwner !== null && currentOwner !== undefined && currentOwner !== ownerKey) {
    throw new Error("memory projection belongs to another Focus owner; reset the disposable projection");
  }
  if (currentOwner === null || currentOwner === undefined) {
    const countResult = await connection.run(
      "MATCH (n) WHERE NOT n:MemoryProjection RETURN count(n) AS nodeCount",
    );
    const rawCount = countResult.records?.[0]?.get("nodeCount") ?? 0;
    const nodeCount = Number(rawCount);
    if (!Number.isSafeInteger(nodeCount) || nodeCount < 0) throw new Error("invalid Neo4j node count");
    if (nodeCount > 0) {
      throw new Error("nonempty Neo4j database has no Focus owner marker; reset it before projection");
    }
  }
}

export async function acquireMemoryProjection(
  transaction: ProjectionTransaction,
  watermark: number,
  digest: string,
  ownerKey: string,
): Promise<boolean> {
  const result = await transaction.run(
    "MERGE (m:MemoryProjection {id: 'focus-memory'}) " +
      "SET m.lock = coalesce(m.lock, 0) + 1 " +
      "RETURN toFloat(m.watermark) AS watermark, m.digest AS digest, m.ownerKey AS ownerKey, " +
      "toFloat(m.schemaVersion) AS schemaVersion",
  );
  const current = result.records?.[0]?.get("watermark");
  const currentDigest = result.records?.[0]?.get("digest");
  const currentOwnerKey = result.records?.[0]?.get("ownerKey");
  const currentSchemaVersion = result.records?.[0]?.get("schemaVersion");
  if (
    !Number.isSafeInteger(watermark) ||
    watermark < 0 ||
    !/^[0-9a-f]{64}$/.test(digest) ||
    !/^[0-9a-f]{64}$/.test(ownerKey)
  ) {
    throw new Error("invalid memory projection watermark or digest");
  }
  if (currentOwnerKey !== null && currentOwnerKey !== undefined && currentOwnerKey !== ownerKey) {
    throw new Error("memory projection belongs to another Focus owner; reset the disposable projection");
  }
  if (current !== null && current !== undefined && (!Number.isSafeInteger(current) || current > watermark)) {
    throw new Error(`stale memory projection watermark: current=${String(current)} incoming=${watermark}`);
  }
  if (current === watermark && currentDigest !== null && currentDigest !== undefined && currentDigest !== digest) {
    throw new Error("memory projection digest conflicts at the same watermark; reset the disposable projection");
  }
  return current !== watermark ||
    currentDigest === null ||
    currentDigest === undefined ||
    currentSchemaVersion !== PROJECTION_SCHEMA_VERSION;
}

export async function finishMemoryProjection(
  transaction: ProjectionTransaction,
  watermark: number,
  digest: string,
  ownerKey: string,
): Promise<void> {
  await transaction.run(
    "MATCH (m:MemoryProjection {id: 'focus-memory'}) SET m.watermark=$watermark, m.digest=$digest, m.ownerKey=$ownerKey, m.schemaVersion=$schemaVersion REMOVE m.lock",
    { watermark, digest, ownerKey, schemaVersion: PROJECTION_SCHEMA_VERSION },
  );
}

type ConstraintRecord = { get(key: string): unknown };
type MigrationConnection = {
  run(cypher: string, params?: Record<string, unknown>): Promise<{ records: ConstraintRecord[] }>;
};

/** File identity changed from path-only to repository+path. Drop only the obsolete schema rule
 * here; legacy data deletion happens inside the owner-guarded projection transaction. */
export async function migrateLegacyFileProjection(connection: MigrationConnection): Promise<number> {
  const result = await connection.run(
    "SHOW CONSTRAINTS YIELD name, labelsOrTypes, properties " +
      "WHERE 'File' IN labelsOrTypes AND properties = ['path'] RETURN name",
  );
  for (const record of result.records) {
    const name = record.get("name");
    if (typeof name !== "string" || name.length === 0) throw new Error("invalid Neo4j constraint name");
    await connection.run(`DROP CONSTRAINT \`${name.replaceAll("`", "``")}\` IF EXISTS`);
  }
  return result.records.length;
}

const DECISION_PROJECTION_CYPHER = [
  "UNWIND $assertions AS row",
  "MERGE (d:Decision {id: row.assertionId})",
  "OPTIONAL MATCH (d)-[old:DERIVED_FROM]->() DELETE old",
  "OPTIONAL MATCH (d)-[oldHead:HEAD]->() DELETE oldHead",
  "SET d.ownerKey=$ownerKey, d.repository=row.repository, d.branch=row.branch, d.active=row.active,",
  "    d.headRevisionId=row.headRevisionId, d.headKind=row.headKind, d.text=row.text,",
  "    d.revisionCount=row.revisionCount, d.repoRelativePath=row.source.repoRelativePath,",
  "    d.sha256=row.source.sha256, d.sourceVersion=row.source.sourceVersion,",
  "    d.lineStart=row.source.lineStart, d.lineEnd=row.source.lineEnd,",
  "    d.projectedAtWatermark=$watermark, d.projectionDigest=$digest",
  "MERGE (f:File {id: row.fileId})",
  "SET f.repository=row.repository, f.path=row.source.repoRelativePath",
  "MERGE (c:Commit {sha: row.source.sourceVersion})",
  "MERGE (b:Blob {id: row.source.sha256})",
  "MERGE (r:DecisionRevision {id: row.headRevisionId})",
  "MERGE (d)-[:DERIVED_FROM]->(f)",
  "MERGE (d)-[:DERIVED_FROM]->(c)",
  "MERGE (d)-[:DERIVED_FROM]->(b)",
  "MERGE (d)-[:HEAD]->(r)",
].join("\n");

/** The caller has already staged every page in memory at one fixed watermark. One transaction
 * publishes every bounded chunk and removes rows absent from the staged digest atomically. */
export async function projectDecisionSnapshot(
  transaction: ProjectionTransaction,
  snapshot: DecisionSnapshot,
): Promise<void> {
  await transaction.run("MATCH (f:File) WHERE f.id IS NULL DETACH DELETE f");
  for (let offset = 0; offset < snapshot.assertions.length; offset += PROJECTION_WRITE_CHUNK.decisions) {
    const assertions = snapshot.assertions.slice(offset, offset + PROJECTION_WRITE_CHUNK.decisions).map((assertion) => ({
      ...assertion,
      fileId: fileNodeId(assertion.repository, assertion.source.repoRelativePath),
    }));
    await transaction.run(DECISION_PROJECTION_CYPHER, {
      assertions,
      watermark: snapshot.watermark,
      ownerKey: snapshot.ownerKey,
      digest: snapshot.digest,
    });
  }
  await transaction.run(
    "MATCH (d:Decision) WHERE (d.ownerKey IS NULL OR d.ownerKey=$ownerKey) " +
      "AND coalesce(d.projectionDigest, '') <> $digest DETACH DELETE d",
    { ownerKey: snapshot.ownerKey, digest: snapshot.digest },
  );
}
