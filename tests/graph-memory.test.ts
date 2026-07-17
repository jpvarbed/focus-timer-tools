import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  acquireMemoryProjection,
  assertProjectionOwner,
  finishMemoryProjection,
  fileNodeId,
  loadDecisionSnapshot,
  loadProjectionFeed,
  migrateLegacyFileProjection,
  projectDecisionSnapshot,
} from "../scripts/decisionProjection";
import { MAX_TRANSPORT_BYTES, PROJECTION_WRITE_CHUNK } from "../memory/policy";

describe("fixed-watermark decision projection", () => {
  test("walks complete bounded projection feeds and rejects repeated cursors", async () => {
    const schema = z.string();
    const rows = await loadProjectionFeed(async (path) => path.includes("cursor=next")
      ? { items: ["b"], nextCursor: null }
      : { items: ["a"], nextCursor: "next" }, "projection/events", schema);
    expect(rows).toEqual(["a", "b"]);
    await expect(loadProjectionFeed(async () => ({ items: ["a"], nextCursor: "same" }), "projection/events", schema))
      .rejects.toThrow(/cursor repeated/i);
  });

  test("uses byte-safe default page sizes for maximum-size valid records", async () => {
    const paths: string[] = [];
    await loadDecisionSnapshot(async (path) => {
      paths.push(path);
      if (path === "memory/watermark") return { version: 0, assertionCount: 0, ownerKey: "f".repeat(64) };
      if (path.startsWith("memory/states")) return { asOf: 0, assertions: [], nextCursor: null };
      return { asOf: 0, events: [], nextCursor: null };
    });
    expect(paths).toEqual([
      "memory/watermark",
      "memory/states?asOf=0",
      "memory/events?asOf=0",
    ]);

    const repository = `example.com/${"\u0800".repeat(2036)}`;
    const repoRelativePath = "\u0800".repeat(4096);
    const state = {
      assertionId: "a",
      repository,
      branch: "\u0800".repeat(512),
      active: true,
      headRevisionId: "r",
      headKind: "create",
      text: "\u0800".repeat(32768),
      revisionCount: 1,
      source: {
        repoRelativePath,
        sha256: "a".repeat(64),
        sourceVersion: "b".repeat(40),
        lineStart: 1,
        lineEnd: 10_000_000,
      },
    };
    const event = {
      _id: "e",
      agentId: "\u0800".repeat(256),
      taskId: null,
      ts: Number.MAX_SAFE_INTEGER,
      type: "decision",
      summary: "\u0800".repeat(512),
      refs: [
        { type: "relates_to", target: "decision:a" },
        { type: "relates_to", target: "revision:r" },
        { type: "derived_from", target: `file:${fileNodeId(repository, repoRelativePath)}` },
        { type: "derived_from", target: `commit:${"b".repeat(40)}` },
        { type: "derived_from", target: `blob:${"a".repeat(64)}` },
        { type: "derived_from", target: `envelope:${"c".repeat(256)}` },
      ],
      knowledgeGap: false,
      memoryVersion: Number.MAX_SAFE_INTEGER,
      assertionId: "a",
      revisionId: "r",
      action: "create",
      previousRevisionId: null,
    };
    expect(Buffer.byteLength(JSON.stringify({ asOf: 0, assertions: Array(5).fill(state), nextCursor: "c" })))
      .toBeLessThanOrEqual(MAX_TRANSPORT_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ asOf: 0, events: Array(10).fill(event), nextCursor: "c" })))
      .toBeLessThanOrEqual(MAX_TRANSPORT_BYTES);
  });

  test("keeps worst-case Neo4j event write parameters below the transport budget", () => {
    const eventId = "e".repeat(64);
    const targetValue = "\u0800".repeat(1024 - "knowledge:".length);
    const events = Array.from({ length: PROJECTION_WRITE_CHUNK.events }, (_, eventIndex) => ({
      id: `${eventId}${eventIndex}`,
      type: "output",
      summary: "\u0800".repeat(512),
      ts: Number.MAX_SAFE_INTEGER,
      gap: false,
      agentId: "\u0800".repeat(256),
      taskId: null,
      memoryVersion: null,
    }));
    const pairs = events.flatMap((event) => Array.from({ length: 100 }, () => ({
      eventId: event.id,
      value: targetValue,
    })));
    expect(Buffer.byteLength(JSON.stringify({ events }))).toBeLessThanOrEqual(MAX_TRANSPORT_BYTES);
    expect(Buffer.byteLength(JSON.stringify({ pairs }))).toBeLessThanOrEqual(MAX_TRANSPORT_BYTES);
    expect(PROJECTION_WRITE_CHUNK).toEqual({ agents: 25, tasks: 25, knowledge: 50, events: 2, decisions: 5 });
  });

  test("drops the legacy File.path constraint and only path-only File nodes before sync", async () => {
    const calls: string[] = [];
    const dropped = await migrateLegacyFileProjection({
      run: async (cypher) => {
        calls.push(cypher);
        return cypher.startsWith("SHOW CONSTRAINTS")
          ? { records: [{ get: () => "constraint`legacy" }] }
          : { records: [] };
      },
    });
    expect(dropped).toBe(1);
    expect(calls).toEqual([
      expect.stringContaining("properties = ['path']"),
      "DROP CONSTRAINT `constraint``legacy` IF EXISTS",
    ]);
  });

  test("checks owner isolation before any graph migration", async () => {
    const owner = "f".repeat(64);
    await expect(assertProjectionOwner({
      run: async (cypher) => ({
        records: [{ get: (key: string) => cypher.startsWith("OPTIONAL") && key === "ownerKey" ? "e".repeat(64) : 0 }],
      }),
    }, owner)).rejects.toThrow(/another Focus owner/i);
    await expect(assertProjectionOwner({
      run: async (cypher) => ({
        records: [{ get: (key: string) => cypher.startsWith("OPTIONAL") ? null : key === "nodeCount" ? 1 : null }],
      }),
    }, owner)).rejects.toThrow(/nonempty Neo4j/i);
  });

  test("walks every page at one watermark and preserves tombstones", async () => {
    const paths: string[] = [];
    const state = (assertionId: string, revisionId: string, active: boolean) => ({
      assertionId,
      repository: "github.com/jason/focus",
      branch: "main",
      active,
      headRevisionId: revisionId,
      headKind: active ? ("create" as const) : ("tombstone" as const),
      text: active ? "decision" : "",
      revisionCount: active ? 1 : 2,
      source: {
        repoRelativePath: "DECISIONS.md",
        sha256: "a".repeat(64),
        sourceVersion: "b".repeat(40),
        lineStart: 3,
        lineEnd: 3,
      },
    });
    const event = (
      id: string,
      assertionId: string,
      revisionId: string,
      memoryVersion: number,
      action: "create" | "tombstone" = "create",
      previousRevisionId: string | null = null,
    ) => ({
      _id: id,
      agentId: "agent",
      taskId: null,
      ts: 1,
      type: "decision" as const,
      summary: "decision",
      refs: [
        { type: "relates_to", target: `decision:${assertionId}` },
        { type: "relates_to", target: `revision:${revisionId}` },
        { type: "derived_from", target: "file:github.com%2Fjason%2Ffocus:DECISIONS.md" },
        { type: "derived_from", target: `commit:${"b".repeat(40)}` },
        { type: "derived_from", target: `blob:${"a".repeat(64)}` },
      ],
      knowledgeGap: false,
      memoryVersion,
      assertionId,
      revisionId,
      action,
      previousRevisionId,
    });
    const get = async (path: string) => {
      paths.push(path);
      if (path === "memory/watermark") return { version: 3, assertionCount: 2, ownerKey: "f".repeat(64) };
      if (path.startsWith("memory/events")) {
        if (path.includes("cursor=e2")) {
          return { asOf: 3, events: [event("e3", "a2", "r3", 3, "tombstone", "r2")], nextCursor: null };
        }
        if (path.includes("cursor=e1")) {
          return { asOf: 3, events: [event("e2", "a2", "r2", 2)], nextCursor: "e2" };
        }
        return {
          asOf: 3,
          events: [event("e1", "a1", "r1", 1)],
          nextCursor: "e1",
        };
      }
      if (!path.includes("cursor=")) {
        return {
          asOf: 3,
          assertions: [state("a1", "r1", true)],
          nextCursor: "a1",
        };
      }
      return {
        asOf: 3,
        assertions: [state("a2", "r3", false)],
        nextCursor: null,
      };
    };
    const snapshot = await loadDecisionSnapshot(get as never, { states: 1, events: 1 });
    expect(snapshot.watermark).toBe(3);
    expect(snapshot.assertions.map((row) => row.active)).toEqual([true, false]);
    expect(snapshot.events.map((row) => row.memoryVersion)).toEqual([1, 2, 3]);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(paths).toEqual([
      "memory/watermark",
      "memory/states?asOf=3&limit=1",
      "memory/states?asOf=3&limit=1&cursor=a1",
      "memory/events?asOf=3&limit=1",
      "memory/events?asOf=3&limit=1&cursor=e1",
      "memory/events?asOf=3&limit=1&cursor=e2",
    ]);
  });

  test("locks the owner projection and rejects an older watermark", async () => {
    const calls: string[] = [];
    const transaction = {
      run: async (cypher: string) => {
        calls.push(cypher);
        return cypher.startsWith("MERGE (m:MemoryProjection")
          ? { records: [{ get: (key: string) => key === "watermark" ? 50 : key === "ownerKey" ? "f".repeat(64) : key === "schemaVersion" ? 2 : "a".repeat(64) }] }
          : { records: [] };
      },
    };
    await expect(acquireMemoryProjection(transaction, 42, "a".repeat(64), "f".repeat(64))).rejects.toThrow(/stale/i);
    await acquireMemoryProjection(
      { run: async () => ({ records: [{ get: (key: string) => key === "watermark" ? 41 : key === "ownerKey" ? "f".repeat(64) : key === "schemaVersion" ? 2 : null }] }) },
      42,
      "a".repeat(64),
      "f".repeat(64),
    );
    expect(
      await acquireMemoryProjection(
        { run: async () => ({ records: [{ get: (key: string) => key === "watermark" ? 42 : key === "ownerKey" ? "f".repeat(64) : key === "schemaVersion" ? 2 : "a".repeat(64) }] }) },
        42,
        "a".repeat(64),
        "f".repeat(64),
      ),
    ).toBe(false);
    await expect(
      acquireMemoryProjection(
        { run: async () => ({ records: [{ get: (key: string) => key === "watermark" ? 42 : key === "ownerKey" ? "f".repeat(64) : key === "schemaVersion" ? 2 : "b".repeat(64) }] }) },
        42,
        "a".repeat(64),
        "f".repeat(64),
      ),
    ).rejects.toThrow(/digest/i);
    await expect(
      acquireMemoryProjection(
        { run: async () => ({ records: [{ get: (key: string) => key === "ownerKey" ? "e".repeat(64) : null }] }) },
        42,
        "a".repeat(64),
        "f".repeat(64),
      ),
    ).rejects.toThrow(/another Focus owner/i);
    expect(
      await acquireMemoryProjection(
        { run: async () => ({ records: [{ get: (key: string) => key === "watermark" ? 42 : null }] }) },
        42,
        "a".repeat(64),
        "f".repeat(64),
      ),
    ).toBe(true);
    await finishMemoryProjection(transaction, 51, "c".repeat(64), "f".repeat(64));
    expect(calls.at(-1)).toContain("SET m.watermark=$watermark");
  });

  test("applies the complete staged snapshot in one transaction call", async () => {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    await projectDecisionSnapshot(
      {
        run: async (cypher, params) => {
          calls.push({ cypher, params: params ?? {} });
          return {};
        },
      },
      {
        watermark: 42,
        assertionCount: 2,
        ownerKey: "f".repeat(64),
        digest: "a".repeat(64),
        assertions: [
          {
            assertionId: "a1",
            repository: "github.com/jason/focus",
            branch: "main",
            active: false,
            headRevisionId: "r2",
            headKind: "tombstone",
            text: "",
            revisionCount: 2,
            source: {
              repoRelativePath: "DECISIONS.md",
              sha256: "a".repeat(64),
              sourceVersion: "b".repeat(40),
              lineStart: 3,
              lineEnd: 3,
            },
          },
          {
            assertionId: "a2",
            repository: "github.com/other/repo",
            branch: "main",
            active: true,
            headRevisionId: "r3",
            headKind: "create",
            text: "same path, other repository",
            revisionCount: 1,
            source: {
              repoRelativePath: "DECISIONS.md",
              sha256: "c".repeat(64),
              sourceVersion: "d".repeat(40),
              lineStart: 1,
              lineEnd: 1,
            },
          },
        ],
        events: [],
      },
    );
    expect(calls).toHaveLength(3);
    expect(calls[0]!.cypher).toContain("f.id IS NULL");
    expect(calls[1]!.cypher).toContain("MERGE (d:Decision");
    expect(calls[1]!.cypher).toContain("MERGE (f:File {id: row.fileId})");
    expect(calls[1]!.cypher).toContain("DELETE old");
    expect(calls[1]!.cypher).toContain("MERGE (d)-[:HEAD]->(r)");
    expect(calls[1]!.params.digest).toBe("a".repeat(64));
    expect(calls[2]!.cypher).toContain("projectionDigest");
    expect(calls[1]!.params).toMatchObject({ watermark: 42, ownerKey: "f".repeat(64) });
    expect((calls[1]!.params.assertions as Array<{ active: boolean }>)[0]!.active).toBe(false);
    expect(
      new Set(
        (calls[1]!.params.assertions as Array<{ repository: string; source: { repoRelativePath: string } }>).map(
          (row) => `${row.repository}:${row.source.repoRelativePath}`,
        ),
      ).size,
    ).toBe(2);
  });

  test("preserves the five-state HTTP boundary in Neo4j write parameters", async () => {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const assertions = Array.from({ length: 6 }, (_, index) => ({
      assertionId: `a${index}`,
      repository: "github.com/jason/focus",
      branch: "main",
      active: true,
      headRevisionId: `r${index}`,
      headKind: "create" as const,
      text: "\u0800".repeat(32768),
      revisionCount: 1,
      source: {
        repoRelativePath: "\u0800".repeat(4096),
        sha256: "a".repeat(64),
        sourceVersion: "b".repeat(40),
        lineStart: 1,
        lineEnd: 1,
      },
    }));
    await projectDecisionSnapshot(
      {
        run: async (cypher, params) => {
          calls.push({ cypher, params: params ?? {} });
          return {};
        },
      },
      {
        watermark: 6,
        assertionCount: assertions.length,
        ownerKey: "f".repeat(64),
        digest: "a".repeat(64),
        assertions,
        events: [],
      },
    );
    const writes = calls.filter((call) => call.cypher.includes("UNWIND $assertions"));
    expect(writes.map((call) => (call.params.assertions as unknown[]).length)).toEqual([5, 1]);
    for (const write of writes) {
      expect(Buffer.byteLength(JSON.stringify(write.params))).toBeLessThanOrEqual(MAX_TRANSPORT_BYTES);
    }
  });
});
