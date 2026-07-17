import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  canonicalJson,
  ENVELOPE_ID,
  parseEnvelope,
  LoadReceiptSchema,
  OWNER_KEY,
  requireEnvelopeId,
  type MemoryEnvelope,
  type ServerReceipt,
} from "./contracts";

export type SpoolPaths = ReturnType<typeof spoolPaths>;

function spoolPaths(
  root = process.env.FOCUS_MEMORY_SPOOL ?? path.join(os.homedir(), ".local", "share", "focus", "memory"),
) {
  return {
    root,
    pending: path.join(root, "pending"),
    receipts: path.join(root, "receipts"),
    quarantine: path.join(root, "quarantine"),
    attempts: path.join(root, "attempts"),
  };
}

export function ensureSpool(root?: string): SpoolPaths {
  const dirs = spoolPaths(root);
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`spool directory must be a real directory: ${dir}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw new Error(`spool directory must be owned by the current user: ${dir}`);
    }
    if ((stat.mode & 0o077) !== 0) throw new Error(`spool directory permissions must be 0700: ${dir}`);
  }
  return dirs;
}

export function bindSpoolOwner(root: string | undefined, ownerKey: string, allowBinding: boolean): void {
  if (!OWNER_KEY.test(ownerKey)) throw new Error("Focus owner key must be 64 lowercase hex characters");
  const marker = path.join(ensureSpool(root).root, "owner.json");
  if (!existsSync(marker)) {
    if (!allowBinding) {
      throw new Error("memory spool is unassigned; rerun with explicit owner binding after verifying the API key");
    }
    writeAtomic(marker, `${JSON.stringify({ schemaVersion: 1, ownerKey }, null, 2)}\n`);
    return;
  }
  const parsed = JSON.parse(readRegularFileNoFollow(marker).toString("utf8")) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (parsed as { ownerKey?: unknown }).ownerKey !== ownerKey
  ) {
    throw new Error("memory spool belongs to another Focus owner");
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeDurable(filePath: string, data: string | Buffer): void {
  writeFileSync(filePath, data, { flag: "wx", mode: 0o600 });
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeAtomic(target: string, data: string): void {
  if (existsSync(target)) {
    if (readRegularFileNoFollow(target).toString("utf8") !== data) {
      throw new Error(`existing spool artifact conflicts with ${target}`);
    }
    return;
  }
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeDurable(temp, data);
  try {
    linkSync(temp, target);
    unlinkSync(temp);
  } catch (error) {
    rmSync(temp, { force: true });
    if (!existsSync(target)) throw error;
    if (readRegularFileNoFollow(target).toString("utf8") !== data) {
      throw new Error(`concurrent spool artifact conflicts with ${target}`);
    }
  }
  fsyncDirectory(path.dirname(target));
}

function replaceAtomic(target: string, data: string): void {
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  writeDurable(temp, data);
  try {
    renameSync(temp, target);
    fsyncDirectory(path.dirname(target));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export function spoolEnvelope(envelope: MemoryEnvelope, root?: string): void {
  const target = path.join(ensureSpool(root).pending, `${envelope.envelopeId}.json`);
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  parseEnvelope(serialized);
  writeAtomic(target, serialized);
}

function readRegularFileNoFollow(filePath: string): Buffer {
  const linkStat = lstatSync(filePath);
  if (!linkStat.isFile() || linkStat.isSymbolicLink()) throw new Error("spool artifact must be a regular non-symlink file");
  const fd = openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) throw new Error("spool artifact must be a regular file");
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readPendingEnvelope(filePath: string, name = path.basename(filePath)): MemoryEnvelope {
  const match = /^(env_[0-9a-f]{64})\.json$/.exec(name);
  if (match === null || !ENVELOPE_ID.test(match[1]!)) throw new Error("pending filename is not a canonical envelope id");
  const envelope = parseEnvelope(readRegularFileNoFollow(filePath).toString("utf8"));
  if (envelope.envelopeId !== match[1]) throw new Error("pending filename does not match envelopeId");
  return envelope;
}

export function loadPendingEnvelopes(root?: string): Array<{ path: string; envelope: MemoryEnvelope }> {
  const dirs = ensureSpool(root);
  return readdirSync(dirs.pending)
    .filter((name) => /^env_[0-9a-f]{64}\.json$/.test(name))
    .sort()
    .map((name) => {
      const filePath = path.join(dirs.pending, name);
      return { path: filePath, envelope: readPendingEnvelope(filePath, name) };
    });
}

export function archiveLoaded(
  root: string | undefined,
  pendingPath: string,
  envelope: MemoryEnvelope,
  receipt: ServerReceipt,
  ownerKey: string,
): void {
  const finalDir = path.join(ensureSpool(root).receipts, envelope.envelopeId);
  const verifyExistingArchive = () => {
    const stat = lstatSync(finalDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("receipt archive must be a real directory");
    const existingEnvelope = parseEnvelope(readRegularFileNoFollow(path.join(finalDir, "envelope.json")).toString("utf8"));
    const existingReceipt = LoadReceiptSchema.parse(
      JSON.parse(readRegularFileNoFollow(path.join(finalDir, "receipt.json")).toString("utf8")) as unknown,
    );
    const archivedOwner = readRegularFileNoFollow(path.join(finalDir, "owner-key")).toString("utf8").trim();
    const comparableExisting = { ...existingReceipt, replayed: false };
    const comparableIncoming = { ...receipt, replayed: false };
    if (
      canonicalJson(existingEnvelope) !== canonicalJson(envelope) ||
      canonicalJson(comparableExisting) !== canonicalJson(comparableIncoming) ||
      archivedOwner !== ownerKey
    ) {
      throw new Error(`existing receipt archive conflicts with ${envelope.envelopeId}`);
    }
  };
  if (existsSync(finalDir)) {
    verifyExistingArchive();
  } else {
    const tempDir = `${finalDir}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(tempDir, { mode: 0o700 });
    writeDurable(path.join(tempDir, "envelope.json"), `${JSON.stringify(envelope, null, 2)}\n`);
    writeDurable(path.join(tempDir, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
    writeDurable(path.join(tempDir, "owner-key"), `${ownerKey}\n`);
    fsyncDirectory(tempDir);
    try {
      renameSync(tempDir, finalDir);
    } catch (error) {
      rmSync(tempDir, { recursive: true, force: true });
      if (!existsSync(finalDir)) throw error;
      verifyExistingArchive();
    }
    // Keep this outside the rename collision handler: if persistence of the new directory entry
    // fails, pending input must remain so a crash cannot lose both copies.
    fsyncDirectory(path.dirname(finalDir));
  }
  if (existsSync(pendingPath)) {
    unlinkSync(pendingPath);
    fsyncDirectory(path.dirname(pendingPath));
  }
}

export function quarantineEnvelope(
  root: string | undefined,
  pendingPath: string,
  envelopeId: string,
  error: Error,
): void {
  const finalDir = path.join(ensureSpool(root).quarantine, path.basename(envelopeId));
  const pending = readRegularFileNoFollow(pendingPath);
  if (existsSync(finalDir)) {
    const stat = lstatSync(finalDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("quarantine archive must be a real directory");
    const existing = readRegularFileNoFollow(path.join(finalDir, "envelope.json"));
    if (!existing.equals(pending)) throw new Error(`existing quarantine conflicts with ${path.basename(envelopeId)}`);
  } else {
    const tempDir = `${finalDir}.${process.pid}.${randomUUID()}.tmp`;
    mkdirSync(tempDir, { mode: 0o700 });
    writeDurable(path.join(tempDir, "envelope.json"), pending);
    writeDurable(path.join(tempDir, "reason.json"), `${JSON.stringify({ reason: error.message }, null, 2)}\n`);
    fsyncDirectory(tempDir);
    renameSync(tempDir, finalDir);
    fsyncDirectory(path.dirname(finalDir));
  }
  if (existsSync(pendingPath)) {
    unlinkSync(pendingPath);
    fsyncDirectory(path.dirname(pendingPath));
  }
}

export function recordAttempt(root: string | undefined, envelopeId: string, error: Error): void {
  requireEnvelopeId(envelopeId);
  const target = path.join(ensureSpool(root).attempts, `${envelopeId}.json`);
  let attemptCount = 0;
  if (existsSync(target)) {
    try {
      const prior = JSON.parse(readRegularFileNoFollow(target).toString("utf8")) as { attemptCount?: unknown };
      if (Number.isSafeInteger(prior.attemptCount) && (prior.attemptCount as number) >= 0) {
        attemptCount = prior.attemptCount as number;
      }
    } catch {
      // Replace corrupt attempt telemetry; pending input remains the source of truth.
    }
  }
  replaceAtomic(
    target,
    `${JSON.stringify({ envelopeId, error: error.message, at: new Date().toISOString(), attemptCount: attemptCount + 1 }, null, 2)}\n`,
  );
}

export function collectorStatus(root?: string) {
  const dirs = ensureSpool(root);
  const pendingNames = readdirSync(dirs.pending);
  return {
    pending: pendingNames.filter((name) => /^env_[0-9a-f]{64}\.json$/.test(name)).length,
    unknown: pendingNames.filter((name) => !/^env_[0-9a-f]{64}\.json$/.test(name)).length,
    receipts: readdirSync(dirs.receipts).filter((name) => !name.startsWith(".")).length,
    quarantined: readdirSync(dirs.quarantine).filter((name) => !name.startsWith(".")).length,
    attempts: readdirSync(dirs.attempts).filter((name) => name.endsWith(".json")).length,
  };
}

export function readLocalReceipt(root: string | undefined, envelopeId: string): ServerReceipt | null {
  requireEnvelopeId(envelopeId);
  const filePath = path.join(ensureSpool(root).receipts, envelopeId, "receipt.json");
  if (!existsSync(filePath)) return null;
  const directory = path.dirname(filePath);
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("receipt archive must be a real directory");
  const value: unknown = JSON.parse(readRegularFileNoFollow(filePath).toString("utf8"));
  const receipt = LoadReceiptSchema.parse(value);
  if (receipt.envelopeId !== envelopeId) throw new Error("local receipt envelopeId does not match its directory");
  return receipt;
}
