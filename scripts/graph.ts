#!/usr/bin/env bun
/**
 * graph.ts — project the Convex provenance log into Neo4j and query it (FOC-14 / slice 4).
 *
 * Convex is the source of truth; Neo4j is a read-side projection (batch, idempotent MERGE).
 * Convex can't open Bolt, so this runs externally.
 *
 * Env: FOCUS_USER_ID, CONVEX_URL (default prod), NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD.
 *
 * Commands:
 *   bun scripts/graph.ts sync                 project Convex -> Neo4j
 *   bun scripts/graph.ts stats                node/edge counts
 *   bun scripts/graph.ts lineage <ref>        what fed a ref (knowledge:slug | commit:sha | file:path)
 *   bun scripts/graph.ts knowledge <slug>     which decisions cited a concept (query c)
 *   bun scripts/graph.ts patterns             orphan tasks + most-cited knowledge (query d)
 */
import neo4j, { type Driver } from "neo4j-driver";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const CONVEX = process.env.CONVEX_URL ?? "https://perceptive-butterfly-406.convex.cloud";
const USER = process.env.FOCUS_USER_ID;
const NEO4J_URI = process.env.NEO4J_URI;
const NEO4J_USER = process.env.NEO4J_USERNAME ?? "neo4j";
const NEO4J_PW = process.env.NEO4J_PASSWORD;

if (!USER) throw new Error("FOCUS_USER_ID required");
if (!NEO4J_URI || !NEO4J_PW) throw new Error("NEO4J_URI + NEO4J_PASSWORD required");

const cx = new ConvexHttpClient(CONVEX);
const q = (n: string) => makeFunctionReference<"query">(n);

const REL_TYPES = new Set(["informs", "produces", "lands_in", "derived_from", "relates_to"]);
const relType = (t: string) => (REL_TYPES.has(t) ? t.toUpperCase() : "RELATES_TO");

// target kind -> [label, keyProp]
const TARGET: Record<string, [string, string]> = {
  knowledge: ["Knowledge", "slug"],
  commit: ["Commit", "sha"],
  file: ["File", "path"],
  task: ["Task", "id"],
  ask: ["Ask", "id"],
  blob: ["Blob", "id"],
};

async function sync(driver: Driver) {
  const [agents, tasksA, tasksD, events, knowledge] = await Promise.all([
    cx.query(q("fleet:list"), { userId: USER }) as Promise<any[]>,
    cx.query(q("fleet:tasks"), { userId: USER }) as Promise<any[]>,
    cx.query(q("fleet:taskHistory"), { userId: USER }) as Promise<any[]>,
    cx.query(q("fleet:events"), { userId: USER, limit: 2000 }) as Promise<any[]>,
    cx.query(q("knowledge:list"), { userId: USER, limit: 2000 }) as Promise<any[]>,
  ]);
  const tasks = [...tasksA, ...tasksD];
  const s = driver.session();
  try {
    for (const c of [
      "FOR (n:Project) REQUIRE n.name IS UNIQUE",
      "FOR (n:Task) REQUIRE n.id IS UNIQUE",
      "FOR (n:Agent) REQUIRE n.id IS UNIQUE",
      "FOR (n:Knowledge) REQUIRE n.slug IS UNIQUE",
      "FOR (n:Event) REQUIRE n.id IS UNIQUE",
      "FOR (n:Commit) REQUIRE n.sha IS UNIQUE",
      "FOR (n:File) REQUIRE n.path IS UNIQUE",
    ]) {
      await s.run(`CREATE CONSTRAINT IF NOT EXISTS ${c}`);
    }

    await s.run(
      `UNWIND $tasks AS t
       MERGE (task:Task {id: t._id}) SET task.title=t.title, task.status=t.status, task.priority=t.priority
       MERGE (p:Project {name: t.project}) MERGE (p)-[:CONTAINS]->(task)`,
      { tasks },
    );
    await s.run(
      `UNWIND $agents AS a
       MERGE (ag:Agent {id: a.agentId}) SET ag.source=a.source, ag.state=a.state, ag.project=a.project
       MERGE (p:Project {name: a.project}) MERGE (ag)-[:WORKS_IN]->(p)
       FOREACH (_ IN CASE WHEN a.taskId IS NULL THEN [] ELSE [1] END |
         MERGE (t:Task {id: a.taskId}) MERGE (ag)-[:ON]->(t))`,
      { agents },
    );
    await s.run(
      `UNWIND $k AS c MERGE (n:Knowledge {slug: c.slug}) SET n.title=c.title`,
      { k: knowledge },
    );

    for (const e of events) {
      await s.run(
        `MERGE (ev:Event {id: $id}) SET ev.type=$type, ev.summary=$summary, ev.ts=$ts, ev.knowledgeGap=$gap
         MERGE (a:Agent {id: $agentId}) MERGE (a)-[:MADE]->(ev)`,
        { id: e._id, type: e.type, summary: e.summary, ts: e.ts, gap: e.knowledgeGap, agentId: e.agentId },
      );
      for (const ref of e.refs ?? []) {
        const [kind, ...rest] = String(ref.target).split(":");
        const value = rest.join(":");
        const spec = TARGET[kind];
        if (!spec || !value) continue;
        const [label, key] = spec;
        await s.run(
          `MATCH (ev:Event {id: $id})
           MERGE (t:${label} {${key}: $value})
           MERGE (ev)-[:${relType(ref.type)}]->(t)`,
          { id: e._id, value },
        );
      }
    }
    console.log(
      `synced: ${agents.length} agents · ${tasks.length} tasks · ${events.length} events · ${knowledge.length} concepts`,
    );
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
    } else if (cmd === "stats") {
      const nodes = await run(driver, "MATCH (n) RETURN labels(n)[0] AS label, count(*) AS n ORDER BY n DESC");
      const rels = await run(driver, "MATCH ()-[r]->() RETURN type(r) AS rel, count(*) AS n ORDER BY n DESC");
      console.log("nodes:", nodes.map((r) => `${r.get("label")}=${r.get("n")}`).join(" "));
      console.log("edges:", rels.map((r) => `${r.get("rel")}=${r.get("n")}`).join(" "));
    } else if (cmd === "lineage") {
      // (c) what fed this ref: events that reference it + the agent + the event's other refs
      const recs = await run(
        driver,
        `MATCH (ev:Event)-[r]->(t) WHERE (t.slug=$k OR t.sha=$k OR t.path=$k OR t.id=$k)
         MATCH (a:Agent)-[:MADE]->(ev)
         OPTIONAL MATCH (ev)-[r2]->(o) WHERE o <> t
         RETURN ev.type AS type, ev.summary AS summary, a.id AS agent,
                collect(DISTINCT type(r2)+':'+coalesce(o.slug,o.sha,o.path,o.id)) AS alsoRefs`,
        { k: arg },
      );
      if (!recs.length) console.log(`nothing references ${arg}`);
      for (const r of recs)
        console.log(`${r.get("agent")} [${r.get("type")}] ${r.get("summary")}  also→ ${r.get("alsoRefs").filter(Boolean).join(", ")}`);
    } else if (cmd === "knowledge") {
      // (c) decisions that cited a concept
      const recs = await run(
        driver,
        `MATCH (k:Knowledge {slug:$s})<-[:INFORMS]-(ev:Event)<-[:MADE]-(a:Agent)
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
