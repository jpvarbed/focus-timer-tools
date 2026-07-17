import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SELF = path.basename(import.meta.path);
const EXCLUDED = new Set(["node_modules", ".git", "dist", ".vercel"]);
const SOURCE = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const MANIFESTS = new Set(["package.json", "bun.lock", "package-lock.json"]);
const MODEL_ENV = new RegExp(`process\\.env\\.(${"GEM" + "INI"}|${"GOO" + "GLE"})`, "i");
const SDK_IMPORT = new RegExp(`@${"goo" + "gle"}/|generative-ai`, "i");
const ENDPOINT = `${"generativelanguage." + "googleapis.com"}`;

function filesUnder(root: string): string[] {
  if (!statSync(root).isDirectory()) throw new Error(`scan root is not a directory: ${root}`);
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current)) {
      const absolute = path.join(current, name);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        if (!EXCLUDED.has(name)) stack.push(absolute);
      } else if (
        stat.isFile() &&
        name !== SELF &&
        (MANIFESTS.has(name) || SOURCE.has(path.extname(name)))
      ) {
        out.push(absolute);
      }
    }
  }
  return out;
}

describe("tools no-model runtime boundary", () => {
  test("contains no model environment, SDK, dependency, or endpoint fallback", () => {
    const files = filesUnder(ROOT);
    expect(files.length).toBeGreaterThan(10);
    const findings: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (MODEL_ENV.test(source)) findings.push(`${file}: model environment read`);
      if (SDK_IMPORT.test(source)) findings.push(`${file}: model SDK/dependency`);
      if (source.includes(ENDPOINT)) findings.push(`${file}: model endpoint`);
    }
    expect(findings).toEqual([]);
  });
});
