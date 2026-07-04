#!/usr/bin/env bun
/**
 * ingest-decisions — pull decisions you already wrote down into the focus provenance graph (FOC-38).
 *
 * The graph starves not because decisions aren't recorded but because they live in files it never
 * reads: ADRs at `<repo>/docs/adr/NNNN-*.md`, each with Context / Decision / Alternatives. This walks
 * every repo under a root (default ~/dev), and for each ADR:
 *   - upserts a KNOWLEDGE concept (the durable lesson: title + Context + Decision), and
 *   - records a DECISION event (the choice, with the rejected alternative) that CITES that concept.
 * That decision→knowledge citation is the INFORMS edge the graph exists for.
 *
 * Idempotent: decision events are append-only, so ingested ADRs are tracked in a state file and
 * skipped on re-run (knowledge upserts dedup by slug server-side anyway). `--force` re-ingests.
 * `--dry-run` parses and prints the tuples without writing or touching state.
 *
 * Env: FOCUS_API_KEY (required unless --dry-run) · FOCUS_CONVEX_SITE (defaults to prod .convex.site).
 * Usage: bun scripts/ingest-decisions.ts [--dry-run] [--force] [--root DIR]
 */
import { Glob } from "bun";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";
const FOCUS_KEY = process.env.FOCUS_API_KEY ?? "";
const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const FORCE = args.has("--force");
const rootFlag = process.argv.find((a, i) => process.argv[i - 1] === "--root");
const ROOT = rootFlag ?? join(homedir(), "dev");
const STATE_FILE = join(homedir(), ".local", "state", "focus-decision-ingest.json");

type State = { ingested: Record<string, { hash: string; slug?: string; ts: number }> };

function loadState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return { ingested: {} };
  }
}
function saveState(s: State) {
  mkdirSync(join(homedir(), ".local", "state"), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${FOCUS_SITE}/agent/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FOCUS_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

function hash(s: string): string {
  return new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 16);
}
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function clamp(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
}

/** Split a markdown doc into `## Section` blocks (### stays inside its parent ##). */
function sections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = "_preamble";
  const buf: Record<string, string[]> = { _preamble: [] };
  for (const line of md.split("\n")) {
    const m = line.match(/^##\s+([^#].*)$/); // exactly "## " (not "### ")
    if (m) {
      key = m[1].trim().toLowerCase();
      buf[key] = [];
    } else {
      (buf[key] ??= []).push(line);
    }
  }
  for (const k of Object.keys(buf)) out[k] = buf[k].join("\n").trim();
  return out;
}

type Parsed = {
  externalId: string;
  repo: string;
  num: string;
  status: string;
  conceptTitle: string;
  conceptBody: string;
  decisionSummary: string;
  rejected: string | null;
  contentHash: string;
};

const INGEST_STATUS = /^(accepted|superseded|amended|rejected)/i;

function parseAdr(repo: string, file: string, raw: string): Parsed | null {
  const h1 = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "";
  // "ADR 0004 — Adopt Convex…" / "ADR-0001 — Render…" → strip the ADR-N prefix for a clean concept title.
  const conceptTitleFull = h1.replace(/^ADR[-\s]*\d+\s*[—:-]\s*/i, "").trim();
  const conceptTitle = conceptTitleFull.replace(/\s*\((?:supersed|amend|replac)[^)]*\)\s*$/i, "").trim();
  if (!conceptTitle) return null;

  const statusRaw = raw.match(/^[-\s*]*status:[\s*]*([a-z][\w-]*)/im)?.[1] ?? "";
  if (!INGEST_STATUS.test(statusRaw)) return null; // skip proposed/draft/unknown

  const sec = sections(raw);
  const context = sec["context"] ?? "";
  const decision = sec["decision"] ?? "";
  if (!decision && !context) return null;

  // First bolded alternative, e.g. "- **Keep Hono + zod-openapi…**" → the road not taken.
  const altBlock = sec["alternatives considered"] ?? sec["alternatives"] ?? "";
  const rejected = altBlock.match(/^\s*[-*]\s*\*\*(.+?)\*\*/m)?.[1]?.trim() ?? null;

  const num = file.match(/(\d{3,4})[^/]*\.md$/)?.[1] ?? "0";
  const body = clamp([context && `Context: ${context}`, decision && `Decision: ${decision}`].filter(Boolean).join("\n\n"), 1400);
  const decisionSummary = clamp(rejected ? `${conceptTitle} — over: ${rejected}` : conceptTitle, 240);

  return {
    externalId: `${repo}:adr-${num}`,
    repo, num, status: statusRaw.toLowerCase(),
    conceptTitle, conceptBody: body, decisionSummary, rejected,
    contentHash: hash(raw),
  };
}

async function main() {
  if (!DRY && !FOCUS_KEY) {
    console.error("Set FOCUS_API_KEY (focus web → Settings → Mint key), or pass --dry-run.");
    process.exit(1);
  }
  const glob = new Glob("*/docs/adr/*.md");
  const files: string[] = [];
  for await (const f of glob.scan({ cwd: ROOT, onlyFiles: true })) files.push(join(ROOT, f));
  files.sort();

  const state = loadState();
  const parsed: Parsed[] = [];
  let skippedStatus = 0;
  for (const f of files) {
    const repo = f.slice(ROOT.length + 1).split("/")[0];
    if (repo.includes("node_modules")) continue;
    const p = parseAdr(repo, f, readFileSync(f, "utf8"));
    if (p) parsed.push(p);
    else skippedStatus++;
  }

  console.log(`Found ${files.length} ADR files under ${ROOT} — ${parsed.length} ingestable, ${skippedStatus} skipped (status/parse).\n`);

  let created = 0, already = 0;
  for (const p of parsed) {
    const seen = state.ingested[p.externalId];
    const isNew = FORCE || !seen || seen.hash !== p.contentHash;
    const tag = isNew ? (seen ? "UPDATE" : "NEW   ") : "have  ";
    if (!isNew) { already++; continue; }

    if (DRY) {
      console.log(`  ${tag} [${p.repo} #${p.num}] ${p.decisionSummary}`);
      console.log(`         cites → knowledge:${slugify(p.conceptTitle)}${p.rejected ? "" : "   (no alternative parsed)"}`);
      created++;
      continue;
    }

    // Real run: upsert the concept, then record the decision citing the slug the server returns.
    const k = await post<{ slug: string; created: boolean }>("knowledge/upsert", {
      title: p.conceptTitle, body: p.conceptBody, tags: ["adr", p.repo, p.status.split("-")[0]], project: p.repo,
    });
    const d = await post<{ knowledgeGap: boolean }>("event", {
      agentId: "adr-ingest", type: "decision", summary: p.decisionSummary,
      refs: [{ type: "informs", target: `knowledge:${k.slug}` }],
    });
    state.ingested[p.externalId] = { hash: p.contentHash, slug: k.slug, ts: Date.now() };
    console.log(`  ${tag} [${p.repo} #${p.num}] → decision cites knowledge:${k.slug}${d.knowledgeGap ? " ⚠gap" : ""}`);
    created++;
  }

  if (!DRY) saveState(state);
  console.log(`\n${DRY ? "[dry-run] would " : ""}ingest ${created} decisions · ${already} already current${DRY ? " · no writes, state untouched" : " · state saved"}.`);
}

main().catch((e) => { console.error("ingest failed:", e.message); process.exit(1); });
