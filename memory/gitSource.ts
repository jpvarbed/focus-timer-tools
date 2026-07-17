import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { sha256, type SourceCitation } from "./contracts";

type GitResult = { code: number; stdout: string; stderr: string };

function git(cwd: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
  });
  return {
    code: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

function requireGit(cwd: string, args: string[], message: string): string {
  const result = git(cwd, args);
  if (result.code !== 0 || result.stdout.length === 0) throw new Error(message);
  return result.stdout;
}

function requireGitBytes(cwd: string, args: string[], message: string): Uint8Array {
  const result = spawnSync("git", args, { cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" } });
  if ((result.status ?? 1) !== 0 || result.stdout === null) throw new Error(message);
  return new Uint8Array(result.stdout);
}

function repoRelative(root: string, absolutePath: string): string {
  const relative = path.relative(root, absolutePath);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep).includes("..")) {
    throw new Error("source path is outside the repository");
  }
  return relative.split(path.sep).join("/");
}

/** Canonical repository id: lowercase host, no default port/credentials/scheme/.git. GitHub path
 * is lowercased because GitHub repository identity is case-insensitive. */
export function canonicalizeRemote(remote: string): string {
  const raw = remote.trim();
  if (raw.length === 0 || raw.startsWith("/") || raw.startsWith("./") || raw.startsWith("../")) {
    throw new Error("origin must be a hosted repository remote");
  }
  if (/^file:/i.test(raw)) throw new Error("file/local origin remotes are not supported");

  let host: string;
  let repoPath: string;
  let port = "";
  const scp = /^([^@/:]+)@([^/:]+):(.+)$/.exec(raw);
  if (scp && !raw.includes("://")) {
    if (scp[1] !== "git") throw new Error("embedded remote credentials are not allowed");
    host = scp[2]!;
    repoPath = scp[3]!;
  } else {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error("origin must be an unambiguous hosted repository URL");
    }
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol)) {
      throw new Error("origin uses an unsupported remote scheme");
    }
    const allowedSshUser = url.protocol === "ssh:" && (url.username === "" || url.username === "git");
    if (url.password || (url.username && !allowedSshUser)) {
      throw new Error("embedded remote credentials are not allowed");
    }
    host = url.hostname;
    port = url.port;
    repoPath = url.pathname;
    if (
      (url.protocol === "https:" && port === "443") ||
      (url.protocol === "http:" && port === "80") ||
      (url.protocol === "ssh:" && port === "22")
    ) {
      port = "";
    }
  }

  host = host.toLowerCase();
  if (host === "github.com") port = "";
  repoPath = repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "").replace(/\/+$/g, "");
  if (repoPath.includes("%")) throw new Error("origin path must not contain percent encoding");
  const segments = repoPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error("origin path must not contain empty or dot segments");
  }
  if (!host || segments.length < 2) throw new Error("origin must include a host, owner, and repository");
  if (!host.includes(".") || !host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error("origin host must use canonical DNS labels");
  }
  if (host === "github.com") {
    if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment))) {
      throw new Error("GitHub origin must be exactly github.com/owner/repository");
    }
    repoPath = segments.map((segment) => segment.toLowerCase()).join("/");
  } else {
    if (segments.some((segment) => /[\u0000-\u0020\u007f]/.test(segment))) {
      throw new Error("origin path must not contain whitespace or control characters");
    }
    repoPath = segments.join("/");
  }
  return `${host}${port ? `:${port}` : ""}/${repoPath}`;
}

function repositoryRoot(cwd: string): string {
  return realpathSync(requireGit(cwd, ["rev-parse", "--show-toplevel"], "not inside a Git repository"));
}

function repositoryIdentity(root: string): string {
  const origins = git(root, ["config", "--get-all", "remote.origin.url"]);
  const originUrls = origins.code === 0 ? origins.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (originUrls.length !== 1) throw new Error("repository must have exactly one origin fetch URL");
  return canonicalizeRemote(originUrls[0]!);
}

export function deriveRepositoryScope(cwd: string): { repository: string; branch: string } {
  const root = repositoryRoot(cwd);
  return {
    repository: repositoryIdentity(root),
    branch: requireGit(root, ["symbolic-ref", "--short", "HEAD"], "detached HEAD is not collectable"),
  };
}

export async function deriveCitation(
  cwd: string,
  sourcePath: string,
  lineStart: number,
  lineEnd: number,
): Promise<{ citation: SourceCitation; repositoryRoot: string; absolutePath: string }> {
  const root = repositoryRoot(cwd);
  const absolutePath = realpathSync(path.resolve(cwd, sourcePath));
  const repoRelativePath = repoRelative(root, absolutePath);
  const repository = repositoryIdentity(root);
  const branch = requireGit(root, ["symbolic-ref", "--short", "HEAD"], "detached HEAD is not collectable");
  const sourceVersion = requireGit(root, ["rev-parse", "--verify", "HEAD"], "repository has no committed HEAD");
  if (!/^[0-9a-f]{40}$/.test(sourceVersion)) throw new Error("Git HEAD must be a 40-character object id");
  if (git(root, ["ls-files", "--error-unmatch", "--", repoRelativePath]).code !== 0) {
    throw new Error("source file must be tracked by Git");
  }
  if (git(root, ["status", "--porcelain=v1", "--untracked-files=all", "--", repoRelativePath]).stdout) {
    throw new Error("source file is dirty; commit it before collecting memory");
  }

  const bytes = new Uint8Array(readFileSync(absolutePath));
  const committedBytes = requireGitBytes(
    root,
    ["show", `${sourceVersion}:${repoRelativePath}`],
    "source file is not readable from the cited Git HEAD",
  );
  if (sha256(bytes) !== sha256(committedBytes)) {
    throw new Error("source file bytes do not match the cited Git HEAD; commit the file before collecting memory");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("source file must be valid UTF-8 text");
  }
  const lines = decoded.split(/\r?\n/);
  if (decoded.endsWith("\n")) lines.pop();
  if (
    !Number.isSafeInteger(lineStart) ||
    !Number.isSafeInteger(lineEnd) ||
    lineStart < 1 ||
    lineEnd < lineStart ||
    lineEnd > 10_000_000
  ) {
    throw new Error("source line range must be valid 1-based integers");
  }
  if (lineEnd > lines.length) throw new Error(`source line range ends after line ${lines.length}`);

  const headAfter = requireGit(root, ["rev-parse", "--verify", "HEAD"], "Git HEAD changed during collection");
  const branchAfter = requireGit(root, ["symbolic-ref", "--short", "HEAD"], "Git branch changed during collection");
  const bytesAfter = new Uint8Array(readFileSync(absolutePath));
  if (headAfter !== sourceVersion || branchAfter !== branch || sha256(bytesAfter) !== sha256(bytes)) {
    throw new Error("Git repository or source file changed during collection; retry");
  }

  return {
    citation: {
      repository,
      branch,
      repoRelativePath,
      sha256: sha256(bytes),
      sourceVersion,
      lineStart,
      lineEnd,
    },
    repositoryRoot: root,
    absolutePath,
  };
}
