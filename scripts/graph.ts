#!/usr/bin/env bun
/**
 * graph.ts — project the Convex provenance log into Neo4j and query it (FOC-14 / slice 4).
 *
 * Convex is the source of truth; Neo4j is a read-side projection (batch, idempotent MERGE).
 * Convex can't open Bolt, so this runs externally. Reads come through the keyed HTTP layer
 * (FOC-28) — the owner is derived from FOCUS_API_KEY, so no cleartext userId / browser session.
 *
 * Env: FOCUS_API_KEY, FOCUS_CONVEX_SITE (default the auth deployment's .convex.site),
 *      NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD.
 *
 * Commands:
 *   bun scripts/graph.ts sync                 project Convex -> Neo4j
 *   bun scripts/graph.ts reset                wipe the projection (sync rebuilds it)
 *   bun scripts/graph.ts stats                node/edge counts
 *   bun scripts/graph.ts lineage <ref>        what fed a ref (knowledge:slug | commit:sha | file:repository:path)
 *   bun scripts/graph.ts knowledge <slug>     which decisions cited a concept (query c)
 *   bun scripts/graph.ts patterns             orphan tasks + most-cited knowledge (query d)
 */
import neo4j, { type Driver } from "neo4j-driver";
import { z } from "zod";
import {
  acquireMemoryProjection,
  assertProjectionOwner,
  finishMemoryProjection,
  loadDecisionSnapshot,
  loadProjectionFeed,
  migrateLegacyFileProjection,
  projectDecisionSnapshot,
} from "./decisionProjection";
import { MAX_TRANSPORT_BYTES, PROJECTION_WRITE_CHUNK } from "../memory/policy";

// Reads come through the keyed HTTP layer (FOC-28): the owner is derived from FOCUS_API_KEY, so no
// cleartext userId and no browser session. Points at the auth deployment's .convex.site host.
function validatedSite(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("FOCUS_CONVEX_SITE must be an HTTPS origin (HTTP is allowed only for loopback)");
  }
  return url.origin;
}
const SITE = validatedSite(process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site");
const KEY = process.env.FOCUS_API_KEY;
const NEO4J_URI = process.env.NEO4J_URI;
const NEO4J_USER = process.env.NEO4J_USERNAME ?? "neo4j";
const NEO4J_PW = process.env.NEO4J_PASSWORD;

if (!KEY) throw new Error("FOCUS_API_KEY required");
if (!NEO4J_URI || !NEO4J_PW) throw new Error("NEO4J_URI + NEO4J_PASSWORD required");

async function keyedGet<T>(path: string): Promise<T> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await fetch(`${SITE}/agent/${path}`, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > MAX_TRANSPORT_BYTES) throw new Error(`GET /agent/${path} response exceeds 1 MiB`);
    const body = await res.text();
    if (Buffer.byteLength(body) > MAX_TRANSPORT_BYTES) throw new Error(`GET /agent/${path} response exceeds 1 MiB`);
    if (res.status === 429 && attempt < 5) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10_000)
        : 250 * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }
    if (!res.ok) throw new Error(`GET /agent/${path} failed (${res.status}): ${body.slice(0, 512)}`);
    if (!res.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error(`GET /agent/${path} returned non-JSON content`);
    }
    return JSON.parse(body) as T;
  }
  throw new Error(`GET /agent/${path} exhausted retries`);
}

const REL_TYPES = new Set(["informs", "produces", "lands_in", "derived_from", "relates_to"]);
const relType = (type: string) => {
  if (!REL_TYPES.has(type)) throw new Error(`unsupported provenance relationship type: ${type}`);
  return type.toUpperCase();
};

// target kind -> [label, keyProp]
const TARGET: Record<string, [string, string]> = {
  knowledge: ["Knowledge", "slug"],
  commit: ["Commit", "sha"],
  file: ["File", "id"],
  decision: ["Decision", "id"],
  envelope: ["Envelope", "id"],
  "factory-session": ["FactorySession", "id"],
  task: ["Task", "id"],
  ask: ["Ask", "id"],
  blob: ["Blob", "id"],
  revision: ["DecisionRevision", "id"],
};

const RefSchema = z.object({ type: z.string().min(1), target: z.string().min(1) }).strict();
const EventViewSchema = z
  .object({
    _id: z.string().min(1),
    agentId: z.string().min(1),
    taskId: z.string().min(1).nullable(),
    ts: z.number().int().safe().nonnegative(),
    type: z.enum(["decision", "output", "handoff", "ask_answered"]),
    summary: z.string(),
    refs: z.array(RefSchema),
    knowledgeGap: z.boolean(),
    // Count of pre-allowlist legacy refs the server filtered at the read seam; reported after
    // sync so the drop is never silent. Optional for servers predating the filter.
    omittedLegacyRefs: z.number().int().safe().nonnegative().optional().transform((value) => value ?? 0),
    memoryVersion: z.number().int().safe().positive().nullable().optional().transform((value) => value ?? null),
  })
  .strict()
  .superRefine((event, ctx) => {
    if (event.type !== "decision" && event.memoryVersion !== null) {
      ctx.addIssue({ code: "custom", message: "only durable decision events may carry memoryVersion" });
    }
    if (
      event.memoryVersion === null &&
      event.refs.some((ref) => ref.target.startsWith("decision:") || ref.target.startsWith("revision:"))
    ) {
      ctx.addIssue({ code: "custom", message: "generic events may not create durable decision projection nodes" });
    }
  });
type EventView = z.infer<typeof EventViewSchema>;
const AgentSchema = z
  .object({
    agentId: z.string().min(1),
    source: z.string(),
    state: z.string(),
    project: z.string(),
    taskId: z.string().min(1).nullable(),
  })
  .strict();
const TaskSchema = z
  .object({
    _id: z.string().min(1),
    title: z.string(),
    status: z.string(),
    priority: z.number(),
    project: z.string(),
  })
  .passthrough();
const KnowledgeSchema = z
  .object({ slug: z.string().min(1), title: z.string() })
  .passthrough();
type GraphConnection = {
  run(cypher: string, params?: Record<string, unknown>): Promise<unknown>;
};

async function applyProjectionRows<T>(
  connection: GraphConnection,
  rows: T[],
  chunkSize: number,
  parameter: string,
  cypher: string,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    await connection.run(cypher, { [parameter]: rows.slice(offset, offset + chunkSize) });
  }
}

async function applyEvents(connection: GraphConnection, events: EventView[]): Promise<void> {
  for (let offset = 0; offset < events.length; offset += PROJECTION_WRITE_CHUNK.events) {
    const chunk = events.slice(offset, offset + PROJECTION_WRITE_CHUNK.events);
    await connection.run(
      `UNWIND $events AS e
       MERGE (ev:Event {id: e.id}) SET ev.type=e.type, ev.summary=e.summary, ev.ts=e.ts,
         ev.knowledgeGap=e.gap, ev.taskId=e.taskId, ev.memoryVersion=e.memoryVersion
       MERGE (a:Agent {id: e.agentId}) MERGE (a)-[:MADE]->(ev)`,
      {
        events: chunk.map((event) => ({
          id: event._id,
          type: event.type,
          summary: event.summary,
          ts: event.ts,
          gap: event.knowledgeGap,
          agentId: event.agentId,
          taskId: event.taskId,
          memoryVersion: event.memoryVersion,
        })),
      },
    );
    const buckets = new Map<
      string,
      { label: string; key: string; rel: string; pairs: { eventId: string; value: string }[] }
    >();
    for (const event of chunk) {
      for (const ref of event.refs) {
        const [kind, ...rest] = ref.target.split(":");
        const value = rest.join(":");
        const spec = TARGET[kind];
        if (!spec || !value) throw new Error(`unsupported or empty provenance target: ${ref.target}`);
        const [label, key] = spec;
        const rel = relType(ref.type);
        const bucketKey = `${label}\u0000${key}\u0000${rel}`;
        let bucket = buckets.get(bucketKey);
        if (!bucket) buckets.set(bucketKey, (bucket = { label, key, rel, pairs: [] }));
        bucket.pairs.push({ eventId: event._id, value });
      }
    }
    for (const bucket of buckets.values()) {
      await connection.run(
        `UNWIND $pairs AS p MATCH (ev:Event {id: p.eventId})
         MERGE (t:${bucket.label} {${bucket.key}: p.value}) MERGE (ev)-[:${bucket.rel}]->(t)`,
        { pairs: bucket.pairs },
      );
    }
  }
}

async function sync(driver: Driver) {
  const [agents, tasks, events, knowledge, decisionSnapshot] = await Promise.all([
    loadProjectionFeed(keyedGet, "projection/agents", AgentSchema),
    loadProjectionFeed(keyedGet, "projection/tasks", TaskSchema),
    loadProjectionFeed(keyedGet, "projection/events", EventViewSchema),
    loadProjectionFeed(keyedGet, "projection/knowledge", KnowledgeSchema),
    loadDecisionSnapshot(keyedGet),
  ]);
  const s = driver.session();
  try {
    await assertProjectionOwner(s, decisionSnapshot.ownerKey);
    for (const c of [
      "FOR (n:Project) REQUIRE n.name IS UNIQUE",
      "FOR (n:Task) REQUIRE n.id IS UNIQUE",
      "FOR (n:Agent) REQUIRE n.id IS UNIQUE",
      "FOR (n:Knowledge) REQUIRE n.slug IS UNIQUE",
      "FOR (n:Event) REQUIRE n.id IS UNIQUE",
      "FOR (n:Commit) REQUIRE n.sha IS UNIQUE",
      "FOR (n:File) REQUIRE n.id IS UNIQUE",
      "FOR (n:Decision) REQUIRE n.id IS UNIQUE",
      "FOR (n:Envelope) REQUIRE n.id IS UNIQUE",
      "FOR (n:FactorySession) REQUIRE n.id IS UNIQUE",
      "FOR (n:Blob) REQUIRE n.id IS UNIQUE",
      "FOR (n:DecisionRevision) REQUIRE n.id IS UNIQUE",
      "FOR (n:MemoryProjection) REQUIRE n.id IS UNIQUE",
    ]) {
      await s.run(`CREATE CONSTRAINT IF NOT EXISTS ${c}`);
    }
    await migrateLegacyFileProjection(s);

    const genericEvents = events.filter((event) => event.memoryVersion === null);
    const tx = s.beginTransaction();
    try {
      const shouldApply = await acquireMemoryProjection(
        tx,
        decisionSnapshot.watermark,
        decisionSnapshot.digest,
        decisionSnapshot.ownerKey,
      );
      await applyProjectionRows(
        tx,
        tasks,
        PROJECTION_WRITE_CHUNK.tasks,
        "tasks",
        `UNWIND $tasks AS t
         MERGE (task:Task {id: t._id}) SET task.title=t.title, task.status=t.status, task.priority=t.priority
         MERGE (p:Project {name: t.project}) MERGE (p)-[:CONTAINS]->(task)`,
      );
      await applyProjectionRows(
        tx,
        agents,
        PROJECTION_WRITE_CHUNK.agents,
        "agents",
        `UNWIND $agents AS a
         MERGE (ag:Agent {id: a.agentId}) SET ag.source=a.source, ag.state=a.state, ag.project=a.project
         MERGE (p:Project {name: a.project}) MERGE (ag)-[:WORKS_IN]->(p)
         FOREACH (_ IN CASE WHEN a.taskId IS NULL THEN [] ELSE [1] END |
           MERGE (t:Task {id: a.taskId}) MERGE (ag)-[:ON]->(t))`,
      );
      await applyProjectionRows(
        tx,
        knowledge,
        PROJECTION_WRITE_CHUNK.knowledge,
        "k",
        `UNWIND $k AS c MERGE (n:Knowledge {slug: c.slug}) SET n.title=c.title`,
      );
      await applyEvents(tx, genericEvents);
      if (shouldApply) {
        await applyEvents(
          tx,
          decisionSnapshot.events,
        );
        await projectDecisionSnapshot(tx, decisionSnapshot);
      }
      await finishMemoryProjection(
        tx,
        decisionSnapshot.watermark,
        decisionSnapshot.digest,
        decisionSnapshot.ownerKey,
      );
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
    console.log(
      `synced: ${agents.length} agents · ${tasks.length} tasks · ${genericEvents.length + decisionSnapshot.events.length} events · ${knowledge.length} concepts · ${decisionSnapshot.assertions.length} decisions @ ${decisionSnapshot.watermark}`,
    );
    const omittedLegacyRefs = genericEvents.reduce((sum, event) => sum + event.omittedLegacyRefs, 0);
    if (omittedLegacyRefs > 0) {
      console.log(`note: server filtered ${omittedLegacyRefs} pre-allowlist legacy ref(s) at the read seam`);
    }
  } finally {
    await s.close();
  }
}

async function run(driver: Driver, cypher: string, params: Record<string, unknown> = {}) {
  const s = driver.session();
  try {
    return (await s.run(cypher, params)).records;
  } finally {
    await s.close();
  }
}

async function main() {
  const [cmd = "sync", arg] = process.argv.slice(2);
  const driver = neo4j.driver(NEO4J_URI!, neo4j.auth.basic(NEO4J_USER, NEO4J_PW!));
  try {
    if (cmd === "sync") {
      await sync(driver);
    } else if (cmd === "reset") {
      // The graph is a disposable projection of Convex — wipe and let `sync` rebuild it.
      await run(driver, "MATCH (n) DETACH DELETE n");
      console.log("graph wiped — run `sync` to rebuild from Convex");
    } else if (cmd === "stats") {
      const nodes = await run(driver, "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC");
      const rels = await run(driver, "MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS n ORDER BY n DESC");
      console.log("nodes:", nodes.map((r) => `${r.get("label")}=${r.get("n")}`).join(" "));
      console.log("edges:", rels.map((r) => `${r.get("rel")}=${r.get("n")}`).join(" "));
    } else if (cmd === "lineage") {
      // (c) what fed this ref: events that reference it + the agent + the event's other refs
      const [kind, ...refParts] = (arg ?? "").split(":");
      const value = refParts.join(":");
      const target = TARGET[kind];
      if (!target || !value) throw new Error("lineage ref must be a supported kind:value target");
      const [label, key] = target;
      const recs = await run(
        driver,
        `MATCH (ev:Event)-[r]->(t:${label} {${key}:$k})
         MATCH (a:Agent)-[:MADE]->(ev)
         OPTIONAL MATCH (ev)-[r2]->(o) WHERE o <> t
         RETURN ev.type AS type, ev.summary AS summary, a.id AS agent,
                collect(DISTINCT type(r2)+':'+coalesce(o.slug,o.sha,o.path,o.id)) AS alsoRefs`,
        { k: value },
      );
      if (!recs.length) console.log(`nothing references ${arg}`);
      for (const r of recs)
        console.log(`${r.get("agent")} [${r.get("type")}] ${r.get("summary")}  also→ ${r.get("alsoRefs").filter(Boolean).join(", ")}`);
    } else if (cmd === "knowledge") {
      // (c) decisions that cited a concept
      const recs = await run(
        driver,
        `MATCH (k:Knowledge {slug:$s})<-[:INFORMS]-(ev:Event {type:'decision'})<-[:MADE]-(a:Agent)
         RETURN a.id AS agent, ev.summary AS summary ORDER BY ev.ts DESC`,
        { s: arg },
      );
      console.log(recs.length ? `decisions citing knowledge:${arg}:` : `no decisions cite knowledge:${arg}`);
      for (const r of recs) console.log(`  ${r.get("agent")}: ${r.get("summary")}`);
    } else if (cmd === "patterns") {
      // (d) orphan tasks (no agent) + most-cited knowledge
      const orphans = await run(driver, "MATCH (t:Task) WHERE NOT (:Agent)-[:ON]->(t) RETURN t.title AS title");
      const hot = await run(
        driver,
        "MATCH (k:Knowledge)<-[:INFORMS]-(ev) RETURN k.slug AS slug, count(ev) AS uses ORDER BY uses DESC LIMIT 5",
      );
      console.log("orphan tasks (no agent):", orphans.map((r) => r.get("title")).join(", ") || "none");
      console.log("most-cited knowledge:", hot.map((r) => `${r.get("slug")}=${r.get("uses")}`).join(" ") || "none");
    } else {
      console.error("usage: graph.ts <sync|stats|lineage <ref>|knowledge <slug>|patterns>");
      process.exit(1);
    }
  } finally {
    await driver.close();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
