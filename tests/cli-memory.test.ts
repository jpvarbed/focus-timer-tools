import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "focus-cli-memory-"));
  const spool = mkdtempSync(path.join(os.tmpdir(), "focus-cli-spool-"));
  git(root, "init", "-b", "main");
  git(root, "config", "user.email", "focus-cli@example.com");
  git(root, "config", "user.name", "Focus CLI");
  git(root, "remote", "add", "origin", "git@github.com:JasonVarbedian/Focus-CLI.git");
  const file = path.join(root, "DECISIONS.md");
  writeFileSync(file, "# Decisions\n\nUse Focus for durable memory.\n");
  git(root, "add", "DECISIONS.md");
  git(root, "commit", "-m", "decision");
  return { root, spool, file };
}

async function focus(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "cli/src/index.ts", ...args], {
    cwd: path.join(import.meta.dir, ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("focus memory CLI public seam", () => {
  test("rejects a dirty source even when Git status is suppressed", async () => {
    const f = fixture();
    git(f.root, "update-index", "--assume-unchanged", "DECISIONS.md");
    writeFileSync(f.file, "# Decisions\n\nUncommitted replacement.\n");
    const collected = await focus([
      "collect",
      "decision",
      "cwd=" + f.root,
      "file=" + f.file,
      "lines=3:3",
      "action=create",
      "text=Use Focus where FOO=bar for durable memory.",
      "actor=cli-test",
      "spool=" + f.spool,
      "confirm=true",
    ]);
    expect(collected.exitCode).not.toBe(0);
    expect(collected.stderr).toMatch(/HEAD|committed|dirty/i);
  });

  test("collects, reports status, syncs, recalls, and reuses receipt IDs", async () => {
    const f = fixture();
    const collected = await focus([
      "collect",
      "decision",
      "cwd=" + f.root,
      "file=" + f.file,
      "lines=3:3",
      "action=create",
      "text=Use Focus where FOO=bar for durable memory.",
      "actor=cli-test",
      "spool=" + f.spool,
      "confirm=true",
    ]);
    expect(collected.exitCode).toBe(0);
    const envelope = JSON.parse(collected.stdout) as { envelopeId: string; raw: { text: string } };
    expect(envelope.raw.text).toBe("Use Focus where FOO=bar for durable memory.");

    const status = await focus(["collector-status", "spool=" + f.spool]);
    expect(JSON.parse(status.stdout)).toMatchObject({ pending: 1, receipts: 0 });

    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/agent/memory/watermark") {
          return Response.json({ version: 0, assertionCount: 0, ownerKey: "f".repeat(64) });
        }
        if (url.pathname === "/agent/ingest/batch") {
          const batch = (await request.json()) as { envelopeId: string; clientKey: string };
          return Response.json({
            replayed: false,
            schemaVersion: 1,
            collector: { name: "file-decision", version: "1.0.0" },
            envelopeId: batch.envelopeId,
            clientKey: batch.clientKey,
            serverDigest: "d".repeat(64),
            results: [
              {
                op: "decision.create",
                assertionId: "a1",
                revisionId: "r1",
                currentActiveRevisionId: "r1",
              },
            ],
            provenanceEventIds: ["e1"],
          });
        }
        if (url.pathname === "/agent/memory/search") {
          return Response.json([
            {
              assertionId: "a1",
              revisionId: "r1",
              text: "Use Focus for durable memory.",
              repository: "github.com/jasonvarbedian/focus-cli",
              branch: "main",
              source: {
                repoRelativePath: "DECISIONS.md",
                sha256: "a".repeat(64),
                sourceVersion: "b".repeat(40),
                lineStart: 3,
                lineEnd: 3,
              },
            },
          ]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const env = { FOCUS_API_KEY: "ak_test", FOCUS_CONVEX_SITE: "http://127.0.0.1:" + server.port };
      const synced = await focus(["sync", "spool=" + f.spool, "bind-owner=true"], env);
      expect(synced.exitCode).toBe(0);
      expect(JSON.parse(synced.stdout)).toEqual({ loaded: 1, failed: 0, quarantined: 0 });

      const recalled = await focus(["recall-decisions", "cwd=" + f.root, "query=durable"], env);
      expect(recalled.exitCode).toBe(0);
      expect(recalled.stdout).toContain("Use Focus for durable memory");
      expect(recalled.stdout).toContain("DECISIONS.md:3-3");

      const corrected = await focus([
        "collect",
        "decision",
        "cwd=" + f.root,
        "file=" + f.file,
        "lines=3:3",
        "action=correct",
        "text=Focus owns durable memory.",
        "receipt=" + envelope.envelopeId,
        "spool=" + f.spool,
        "confirm=true",
      ]);
      expect(corrected.exitCode).toBe(0);
      expect(JSON.parse(corrected.stdout).raw).toMatchObject({
        assertionId: "a1",
        expectedActiveRevisionId: "r1",
      });
    } finally {
      server.stop(true);
    }
  }, 15000);
});
