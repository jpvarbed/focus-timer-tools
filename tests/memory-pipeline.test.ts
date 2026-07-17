import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalizeRemote,
  collectFactoryRun,
  collectFileDecision,
  collectorStatus,
  loadPendingEnvelopes,
  readLocalReceipt,
  syncPending,
  transformEnvelope,
  verifyReceiptMatchesBatch,
  type FocusLoader,
  FocusHttpError,
} from "../memory/pipeline";
import { MAX_FACTORY_REASONING_CHARS } from "../memory/policy";

function run(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

function gitFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "focus-memory-repo-"));
  run(root, "git", "init", "-b", "main");
  run(root, "git", "config", "user.email", "focus-test@example.com");
  run(root, "git", "config", "user.name", "Focus Test");
  run(root, "git", "remote", "add", "origin", "git@github.com:JasonVarbedian/Focus-Timer.git");
  const source = path.join(root, "DECISIONS.md");
  writeFileSync(source, ["# Decisions", "", "Use Focus as the durable memory home.", "Keep Neo4j read-only.", ""].join("\n"));
  run(root, "git", "add", "DECISIONS.md");
  run(root, "git", "commit", "-m", "add decisions");
  return { root, source, spoolRoot: mkdtempSync(path.join(os.tmpdir(), "focus-memory-spool-")) };
}

describe("canonical repository identity", () => {
  test("normalizes HTTPS and SCP remotes and lowercases GitHub identity", () => {
    expect(canonicalizeRemote("git@github.com:JasonVarbedian/Focus-Timer.git")).toBe(
      "github.com/jasonvarbedian/focus-timer",
    );
    expect(canonicalizeRemote("ssh://git@GitHub.com:22/JasonVarbedian/Focus-Timer.git")).toBe(
      "github.com/jasonvarbedian/focus-timer",
    );
    expect(canonicalizeRemote("https://example.com:443/Owner/Repo.git/")).toBe("example.com/Owner/Repo");
    expect(canonicalizeRemote("https://example.com:22/Owner/Repo.git")).toBe("example.com:22/Owner/Repo");
    expect(canonicalizeRemote("ssh://git@example.com:443/Owner/Repo.git")).toBe("example.com:443/Owner/Repo");
  });

  test("rejects credentials, local remotes, and incomplete identities", () => {
    expect(() => canonicalizeRemote("https://user:secret@example.com/owner/repo.git")).toThrow(/credentials/i);
    expect(() => canonicalizeRemote("file:///tmp/repo.git")).toThrow(/remote/i);
    expect(() => canonicalizeRemote("/tmp/repo.git")).toThrow(/remote/i);
    expect(() => canonicalizeRemote("https://github.com/only-owner")).toThrow(/owner.*repository/i);
    expect(() => canonicalizeRemote("https://example.com/%6fwner/repo.git")).toThrow(/percent/i);
    expect(() => canonicalizeRemote("https://example.com:99999/owner/repo.git")).toThrow(/origin|URL/i);
    expect(() => canonicalizeRemote("git@a..b.com:owner/repo.git")).toThrow(/host|DNS/i);
    expect(() => canonicalizeRemote("https://github.com/owner/repo/extra.git")).toThrow(/GitHub/i);
    expect(() => canonicalizeRemote("git@example.com:owner/repo with space.git")).toThrow(/whitespace/i);
  });
});

describe("file-decision collector and deterministic ETL", () => {
  test("spools a content-addressed exact Git citation and transforms it", async () => {
    const f = gitFixture();
    const envelope = await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 4,
      action: "create",
      text: "Use Focus as the durable memory home; keep Neo4j read-only.",
      actor: "codex",
      project: "focus",
      confirmed: true,
      observedAt: "2026-07-17T01:00:00.000Z",
      spoolRoot: f.spoolRoot,
    });

    expect(envelope.envelopeId).toMatch(/^env_[0-9a-f]{64}$/);
    expect(envelope.source).toMatchObject({
      repository: "github.com/jasonvarbedian/focus-timer",
      branch: "main",
      repoRelativePath: "DECISIONS.md",
      lineStart: 3,
      lineEnd: 4,
    });
    expect(envelope.source!.sourceVersion).toMatch(/^[0-9a-f]{40}$/);
    expect(loadPendingEnvelopes(f.spoolRoot)).toHaveLength(1);

    const batch = await transformEnvelope(envelope);
    expect(batch.envelopeId).toBe(envelope.envelopeId);
    expect(batch).toMatchObject({
      schemaVersion: 1,
      collector: { name: "file-decision", version: "1.0.0" },
    });
    expect(batch.clientKey).toMatch(/^op_[0-9a-f]{64}$/);
    expect(batch.operations).toEqual([
      expect.objectContaining({
        op: "decision.create",
        repository: "github.com/jasonvarbedian/focus-timer",
        branch: "main",
        sourceRepoRelativePath: "DECISIONS.md",
        lineStart: 3,
        lineEnd: 4,
        confirmed: true,
      }),
    ]);
  });

  test("rejects unconfirmed, dirty, and out-of-range collection while ETL remains checkout-independent", async () => {
    const f = gitFixture();
    const base = {
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 4,
      action: "create" as const,
      text: "Use Focus",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    };
    await expect(collectFileDecision({ ...base, confirmed: false })).rejects.toThrow(/confirm/i);
    await expect(collectFileDecision({ ...base, lineEnd: 99 })).rejects.toThrow(/line/i);

    const envelope = await collectFileDecision(base);
    writeFileSync(f.source, `${readFileSync(f.source, "utf8")}changed\n`);
    await expect(transformEnvelope(envelope)).resolves.toMatchObject({ envelopeId: envelope.envelopeId });
    await expect(collectFileDecision(base)).rejects.toThrow(/dirty/i);
  });

  test("disables Git replacement objects when proving the cited HEAD bytes", async () => {
    const f = gitFixture();
    const originalHead = run(f.root, "git", "rev-parse", "HEAD");
    run(f.root, "git", "checkout", "-b", "replacement");
    writeFileSync(f.source, "# Replaced\n\nFalse replacement text.\n");
    run(f.root, "git", "add", "DECISIONS.md");
    run(f.root, "git", "commit", "-m", "replacement commit");
    const replacementHead = run(f.root, "git", "rev-parse", "HEAD");
    run(f.root, "git", "checkout", "main");
    run(f.root, "git", "replace", originalHead, replacementHead);

    const envelope = await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "create",
      text: "Use Focus",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    expect(envelope.source.sha256).toBe(
      new Bun.CryptoHasher("sha256").update(readFileSync(f.source)).digest("hex"),
    );
  });

  test("rejects working-tree bytes hidden from git status because they are not the cited HEAD blob", async () => {
    const f = gitFixture();
    run(f.root, "git", "update-index", "--assume-unchanged", "DECISIONS.md");
    writeFileSync(f.source, `${readFileSync(f.source, "utf8")}not committed\n`);
    await expect(
      collectFileDecision({
        cwd: f.root,
        file: f.source,
        lineStart: 3,
        lineEnd: 3,
        action: "create",
        text: "Use Focus",
        actor: "codex",
        confirmed: true,
        spoolRoot: f.spoolRoot,
      }),
    ).rejects.toThrow(/HEAD|committed|dirty/i);
  });

  test("correction requires receipt IDs instead of guessing by text", async () => {
    const f = gitFixture();
    await expect(
      collectFileDecision({
        cwd: f.root,
        file: f.source,
        lineStart: 3,
        lineEnd: 3,
        action: "correct",
        text: "Corrected decision",
        actor: "codex",
        confirmed: true,
        spoolRoot: f.spoolRoot,
      }),
    ).rejects.toThrow(/assertionId.*expectedActiveRevisionId/i);
  });
});

describe("Factory receipt collector and spool lifecycle", () => {
  test("Factory output becomes provenance, never an implicit decision", async () => {
    const spoolRoot = mkdtempSync(path.join(os.tmpdir(), "focus-factory-spool-"));
    const receiptPath = path.join(spoolRoot, "factory-result.json");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        sessionId: "014ca9cd-1a7a-4ac1-a425-1407405c970f",
        elapsedMs: 660000,
        toolCalls: 41,
        correctionPrompts: 0,
        tests: [{ command: "bun run test", passed: true, count: 103 }],
        bugs: ["Droid quota ended while a deliberate insecure mutation was active"],
      }),
    );
    const envelope = await collectFactoryRun({
      receiptPath,
      actor: "factory-droid",
      project: "focus",
      confirmed: true,
      spoolRoot,
    });
    const batch = await transformEnvelope(envelope);
    expect(batch.operations).toEqual([
      expect.objectContaining({
        op: "provenance.append",
        type: "output",
        confirmed: true,
      }),
    ]);
    expect(batch.operations.some((op) => op.op.startsWith("decision."))).toBe(false);
  });

  test("Factory ETL deterministically summarizes a large valid receipt inside the server boundary", async () => {
    const spoolRoot = mkdtempSync(path.join(os.tmpdir(), "focus-factory-boundary-"));
    const receiptPath = path.join(spoolRoot, "factory-result.json");
    writeFileSync(receiptPath, JSON.stringify({
      sessionId: "large-run",
      elapsedMs: 1,
      toolCalls: 40,
      correctionPrompts: 0,
      tests: Array.from({ length: 40 }, (_, index) => ({
        command: `bun test case-${index} ${"x".repeat(160)}`,
        passed: true,
        count: 1,
      })),
      bugs: Array.from({ length: 10 }, (_, index) => `bug-${index} ${"y".repeat(160)}`),
    }));
    const envelope = await collectFactoryRun({
      receiptPath,
      actor: "factory-droid",
      confirmed: true,
      spoolRoot,
    });
    const operation = (await transformEnvelope(envelope)).operations[0]!;
    expect(operation.op).toBe("provenance.append");
    if (operation.op !== "provenance.append") throw new Error("expected Factory provenance operation");
    expect(operation.reasoning.length).toBeLessThanOrEqual(MAX_FACTORY_REASONING_CHARS);
    const summary = JSON.parse(operation.reasoning) as {
      testCommandCount: number;
      bugCount: number;
      bugs: string[];
      omittedTests: number;
      omittedBugs: number;
      truncatedBugs: number;
    };
    expect(summary).toMatchObject({ testCommandCount: 40, bugCount: 10 });
    expect(summary.bugs[0]).toStartWith("bug-0");
    expect(summary.omittedTests + summary.omittedBugs).toBeGreaterThan(0);
  });

  test("Factory ETL retains a bounded sample of an oversized valid bug", async () => {
    const spoolRoot = mkdtempSync(path.join(os.tmpdir(), "focus-factory-long-bug-"));
    const receiptPath = path.join(spoolRoot, "factory-result.json");
    writeFileSync(receiptPath, JSON.stringify({
      sessionId: "long-bug-run",
      elapsedMs: 1,
      toolCalls: 1,
      correctionPrompts: 0,
      tests: Array.from({ length: 20 }, (_, index) => ({
        command: `test-${index} ${"x".repeat(500)}`,
        passed: true,
      })),
      bugs: [`root-cause: ${"y".repeat(5_000)}`],
    }));
    const envelope = await collectFactoryRun({ receiptPath, actor: "factory-droid", confirmed: true, spoolRoot });
    const operation = (await transformEnvelope(envelope)).operations[0]!;
    if (operation.op !== "provenance.append") throw new Error("expected Factory provenance operation");
    const summary = JSON.parse(operation.reasoning) as {
      bugs: string[];
      bugCount: number;
      omittedBugs: number;
      truncatedBugs: number;
    };
    expect(operation.reasoning.length).toBeLessThanOrEqual(MAX_FACTORY_REASONING_CHARS);
    expect(summary.bugs).toHaveLength(1);
    expect(summary.bugs[0]).toStartWith("root-cause:");
    expect(summary.bugs[0]).toEndWith("… [truncated]");
    expect(summary).toMatchObject({ bugCount: 1, omittedBugs: 0, truncatedBugs: 1 });
  });

  test("successful sync archives the envelope and stores the server receipt", async () => {
    const f = gitFixture();
    const envelope = await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "create",
      text: "Use Focus",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    const calls: unknown[] = [];
    const loader: FocusLoader = {
      async ownerKey() { return "f".repeat(64); },
      async load(batch) {
        calls.push(batch);
        return {
          replayed: false,
          schemaVersion: 1,
          collector: { name: "file-decision", version: "1.0.0" },
          envelopeId: batch.envelopeId,
          clientKey: batch.clientKey,
          serverDigest: "d".repeat(64),
          results: [{ op: "decision.create", assertionId: "a1", revisionId: "r1", currentActiveRevisionId: "r1" }],
          provenanceEventIds: ["e1"],
        };
      },
    };
    const result = await syncPending({ spoolRoot: f.spoolRoot, loader, bindOwner: true });
    expect(result).toMatchObject({ loaded: 1, failed: 0, quarantined: 0 });
    expect(calls).toHaveLength(1);
    expect(collectorStatus(f.spoolRoot)).toEqual({ pending: 0, unknown: 0, receipts: 1, quarantined: 0, attempts: 0 });
    expect(readLocalReceipt(f.spoolRoot, envelope.envelopeId)).toMatchObject({
      envelopeId: envelope.envelopeId,
      provenanceEventIds: ["e1"],
    });
  });

  test("refuses to load a spool already bound to another Focus owner", async () => {
    const f = gitFixture();
    await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "create",
      text: "Keep owner boundaries explicit",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    let loadCalls = 0;
    const firstOwner: FocusLoader = {
      ownerKey: async () => "a".repeat(64),
      load: async () => {
        loadCalls += 1;
        throw new FocusHttpError(401, "leave the envelope pending");
      },
    };
    await expect(syncPending({ spoolRoot: f.spoolRoot, loader: firstOwner, bindOwner: true })).resolves.toMatchObject({
      failed: 1,
    });
    const secondOwner: FocusLoader = {
      ownerKey: async () => "b".repeat(64),
      load: async () => {
        loadCalls += 1;
        throw new Error("wrong owner must never reach load");
      },
    };
    await expect(syncPending({ spoolRoot: f.spoolRoot, loader: secondOwner })).rejects.toThrow(/another Focus owner/i);
    expect(loadCalls).toBe(1);
    expect(loadPendingEnvelopes(f.spoolRoot)).toHaveLength(1);
  });

  test("keeps a receipt mismatch pending because the server may already have committed", async () => {
    const f = gitFixture();
    await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "create",
      text: "Use Focus",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    const result = await syncPending({
      spoolRoot: f.spoolRoot,
      bindOwner: true,
      loader: {
        async ownerKey() { return "f".repeat(64); },
        async load(batch) {
          return {
            replayed: false,
            schemaVersion: 1,
            collector: batch.collector,
            envelopeId: batch.envelopeId,
            clientKey: batch.clientKey,
            serverDigest: "d".repeat(64),
            results: [],
            provenanceEventIds: [],
          };
        },
      },
    });
    expect(result).toMatchObject({ loaded: 0, failed: 1, quarantined: 0 });
    expect(loadPendingEnvelopes(f.spoolRoot)).toHaveLength(1);
  });

  test("keeps pending work when authentication or deployment availability is transient", async () => {
    const f = gitFixture();
    const envelope = await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "create",
      text: "Retry after key repair",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    const result = await syncPending({
      spoolRoot: f.spoolRoot,
      bindOwner: true,
      loader: {
        ownerKey: async () => "f".repeat(64),
        load: async () => { throw new FocusHttpError(401, "expired key"); },
      },
    });
    expect(result).toMatchObject({ loaded: 0, failed: 1, quarantined: 0 });
    expect(loadPendingEnvelopes(f.spoolRoot).map(({ envelope: pending }) => pending.envelopeId)).toEqual([
      envelope.envelopeId,
    ]);
  });

  test("rejects receipts that name the wrong assertion or active revision", async () => {
    const f = gitFixture();
    const corrected = await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "correct",
      text: "Corrected",
      assertionId: "assertion-expected",
      expectedActiveRevisionId: "revision-old",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    const batch = await transformEnvelope(corrected);
    const base = {
      replayed: false,
      schemaVersion: 1 as const,
      collector: batch.collector,
      envelopeId: batch.envelopeId,
      clientKey: batch.clientKey,
      serverDigest: "d".repeat(64),
      provenanceEventIds: ["event-1"],
    };
    expect(() =>
      verifyReceiptMatchesBatch(batch, {
        ...base,
        results: [{ op: "decision.correct", assertionId: "assertion-wrong", revisionId: "revision-new", currentActiveRevisionId: "revision-new" }],
      }),
    ).toThrow(/assertion/i);
    expect(() =>
      verifyReceiptMatchesBatch(batch, {
        ...base,
        results: [{ op: "decision.correct", assertionId: "assertion-expected", revisionId: "revision-new", currentActiveRevisionId: "revision-other" }],
      }),
    ).toThrow(/active revision/i);
  });

  test("serializes concurrent syncs with a recoverable spool lease", async () => {
    const f = gitFixture();
    await collectFileDecision({
      cwd: f.root,
      file: f.source,
      lineStart: 3,
      lineEnd: 3,
      action: "create",
      text: "Use Focus",
      actor: "codex",
      confirmed: true,
      spoolRoot: f.spoolRoot,
    });
    let releaseLoader!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const loaderGate = new Promise<void>((resolve) => (releaseLoader = resolve));
    const loader: FocusLoader = {
      async ownerKey() { return "f".repeat(64); },
      async load(batch) {
        markStarted();
        await loaderGate;
        return {
          replayed: false,
          schemaVersion: 1,
          collector: batch.collector,
          envelopeId: batch.envelopeId,
          clientKey: batch.clientKey,
          serverDigest: "d".repeat(64),
          results: [{ op: "decision.create", assertionId: "a1", revisionId: "r1", currentActiveRevisionId: "r1" }],
          provenanceEventIds: ["e1"],
        };
      },
    };
    const first = syncPending({ spoolRoot: f.spoolRoot, loader, bindOwner: true });
    await started;
    await expect(syncPending({ spoolRoot: f.spoolRoot, loader })).rejects.toThrow(/lease/i);
    releaseLoader();
    await expect(first).resolves.toMatchObject({ loaded: 1 });
  });

  test("receipt lookup rejects path traversal instead of reading arbitrary JSON", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "focus-receipt-boundary-"));
    const spoolRoot = path.join(root, "spool");
    mkdirSync(path.join(root, "secret"), { recursive: true });
    writeFileSync(path.join(root, "secret", "receipt.json"), JSON.stringify({ envelopeId: "stolen" }));
    expect(() => readLocalReceipt(spoolRoot, "../../secret")).toThrow(/envelope id/i);
  });

  test("receipt lookup validates the on-disk server contract", () => {
    const spoolRoot = mkdtempSync(path.join(os.tmpdir(), "focus-invalid-receipt-"));
    const envelopeId = `env_${"a".repeat(64)}`;
    mkdirSync(path.join(spoolRoot, "receipts", envelopeId), { recursive: true });
    writeFileSync(path.join(spoolRoot, "receipts", envelopeId, "receipt.json"), JSON.stringify({ envelopeId }));
    expect(() => readLocalReceipt(spoolRoot, envelopeId)).toThrow();
  });

  test("never follows a symlink placed in the pending spool", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "focus-symlink-spool-"));
    const envelopeId = `env_${"a".repeat(64)}`;
    mkdirSync(path.join(root, "pending"), { recursive: true, mode: 0o700 });
    const outside = path.join(root, "outside.json");
    writeFileSync(outside, JSON.stringify({ secret: true }));
    const pending = path.join(root, "pending", `${envelopeId}.json`);
    symlinkSync(outside, pending);
    const loader: FocusLoader = {
      ownerKey: async () => "f".repeat(64),
      load: async () => { throw new Error("loader must not be called"); },
    };
    await expect(syncPending({ spoolRoot: root, loader, bindOwner: true })).resolves.toMatchObject({ loaded: 0, failed: 1 });
    expect(readFileSync(outside, "utf8")).toContain("secret");
    unlinkSync(pending);
  });

  test("rejects a symlinked spool directory", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "focus-symlink-directory-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "focus-outside-receipts-"));
    symlinkSync(outside, path.join(root, "receipts"));
    expect(() => collectorStatus(root)).toThrow(/real directory/i);
  });

  test("Factory collector rejects a blank actor before spooling", async () => {
    const spoolRoot = mkdtempSync(path.join(os.tmpdir(), "focus-factory-actor-"));
    const receiptPath = path.join(spoolRoot, "factory-result.json");
    writeFileSync(
      receiptPath,
      JSON.stringify({
        sessionId: "session",
        elapsedMs: 1,
        toolCalls: 1,
        correctionPrompts: 0,
        tests: [],
        bugs: [],
      }),
    );
    await expect(
      collectFactoryRun({ receiptPath, actor: " ", confirmed: true, spoolRoot }),
    ).rejects.toThrow(/actor/i);
  });
});
