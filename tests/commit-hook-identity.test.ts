import { describe, expect, test } from "bun:test";
import path from "node:path";
import { canonicalizeRemote } from "../memory/gitSource";

function canonicalize(remote: string): string {
  const result = Bun.spawnSync(
    ["python3", path.join(import.meta.dir, "..", "scripts", "cc-commit-hook.py"), "--canonicalize", remote],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function fileRef(repository: string, repoRelativePath: string): string {
  const result = Bun.spawnSync(
    [
      "python3",
      path.join(import.meta.dir, "..", "scripts", "cc-commit-hook.py"),
      "--file-ref",
      repository,
      repoRelativePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("commit-hook repository-qualified File identity", () => {
  test("matches the collector over one shared conformance matrix", () => {
    const cases = [
      "git@github.com:JasonVarbedian/Focus-Timer.git",
      "https://example.com:22/Owner/Repo.git",
      "ssh://git@example.com:443/Owner/Repo.git",
      "https://éxample.com/Owner/Repo.git",
      "https://example.com/%6fwner/repo.git",
      "https://example.com:99999/owner/repo.git",
      "https://user:secret@example.com/owner/repo.git",
      "git@a..b.com:owner/repo.git",
    ];
    for (const remote of cases) {
      let collector = "";
      try { collector = canonicalizeRemote(remote); } catch { /* both implementations reject */ }
      expect(canonicalize(remote), remote).toBe(collector);
    }
  });

  test("encodes repository and path components without tuple collisions", () => {
    expect(fileRef("example.com:22/Owner/Repo", "docs/a:b.md")).toBe(
      "file:example.com%3A22%2FOwner%2FRepo:docs%2Fa%3Ab.md",
    );
    expect(fileRef("example.com/Owner/Repo", "docs/a!(b)*.md")).toBe(
      "file:example.com%2FOwner%2FRepo:docs%2Fa%21%28b%29%2A.md",
    );
  });
});
