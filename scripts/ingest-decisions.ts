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
  source: "adr" | "plan";
  label: string; // display id, e.g. "#0004" or "plan:backend"
  status: string;
  conceptTitle: string;
  conceptBody: string;
  decisionSummary: string;
  rejected: string | null;
  contentHash: string;
};

function stripMd(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → text
    .replace(/[*`]/g, "") // strip bold/code marks; keep _ (identifiers like GOOGLE_API_KEY)
    .replace(/\s+/g, " ")
    .trim();
}

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
    repo, source: "adr", label: `#${num}`, status: statusRaw.toLowerCase(),
    conceptTitle, conceptBody: body, decisionSummary, rejected,
    contentHash: hash(raw),
  };
}

/** Parse `# | Decision | Choice | Why` decision-log tables in a PLAN/SPEC doc. The `Decision` cell is
 *  the topic, `Choice` is what was picked, `Why` the reasoning. Rows that reference an ADR are skipped
 *  (the ADR pass already captured them). One decision per row, cited to a concept built from choice+why. */
function parsePlanTables(repo: string, raw: string): Parsed[] {
  const lines = raw.split("\n");
  const out: Parsed[] = [];
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i];
    if (!/^\s*\|.*\bdecision\b.*\bchoice\b/i.test(header)) continue;
    if (!/^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? "")) continue; // needs a |---| separator row
    const cols = header.split("|").map((c) => c.trim()).filter((_, j, a) => j > 0 && j < a.length - 1);
    const di = cols.findIndex((c) => /^decision$/i.test(c));
    const ci = cols.findIndex((c) => /^choice$/i.test(c));
    const wi = cols.findIndex((c) => /^why$/i.test(c));
    if (di < 0 || ci < 0) continue;

    for (let r = i + 2; r < lines.length; r++) {
      const row = lines[r];
      if (!/^\s*\|/.test(row)) break; // table ended
      const cells = row.split("|").map((c) => c.trim()).filter((_, j, a) => j > 0 && j < a.length - 1);
      const topic = stripMd(cells[di] ?? "");
      const choice = stripMd(cells[ci] ?? "");
      const why = wi >= 0 ? stripMd(cells[wi] ?? "") : "";
      if (!topic || !choice) continue;
      if (/\badr[-\s/]?\d/i.test(cells[ci] ?? "") || /\badr[-\s/]?\d/i.test(cells[wi] ?? "")) continue; // ADR already has it

      const conceptTitle = clamp(`${topic}: ${choice}`, 90);
      out.push({
        externalId: `${repo}:plan-${slugify(topic)}`,
        repo, source: "plan", label: `plan:${slugify(topic).slice(0, 20)}`, status: "accepted",
        conceptTitle,
        conceptBody: clamp([`Choice: ${choice}`, why && `Why: ${why}`].filter(Boolean).join("\n\n"), 1400),
        decisionSummary: clamp(`${topic}: ${choice}`, 240),
        rejected: null,
        contentHash: hash(`${topic}|${choice}|${why}`),
      });
    }
  }
  return out;
}

async function main() {
  if (!DRY && !FOCUS_KEY) {
    console.error("Set FOCUS_API_KEY (focus web → Settings → Mint key), or pass --dry-run.");
    process.exit(1);
  }
  const collect = async (pattern: string) => {
    const files: string[] = [];
    for await (const f of new Glob(pattern).scan({ cwd: ROOT, onlyFiles: true })) files.push(join(ROOT, f));
    return files.filter((f) => !f.includes("node_modules")).sort();
  };
  const adrFiles = await collect("*/docs/adr/*.md");
  const planFiles = await collect("*/{PLAN,SPEC,BRIEF}.md");

  const state = loadState();
  const parsed: Parsed[] = [];
  let skippedStatus = 0;
  for (const f of adrFiles) {
    const repo = f.slice(ROOT.length + 1).split("/")[0];
    const p = parseAdr(repo, f, readFileSync(f, "utf8"));
    if (p) parsed.push(p);
    else skippedStatus++;
  }
  for (const f of planFiles) {
    const repo = f.slice(ROOT.length + 1).split("/")[0];
    parsed.push(...parsePlanTables(repo, readFileSync(f, "utf8")));
  }
  const adrN = parsed.filter((p) => p.source === "adr").length;
  const planN = parsed.filter((p) => p.source === "plan").length;

  console.log(`Scanned ${adrFiles.length} ADRs + ${planFiles.length} PLAN/SPEC docs under ${ROOT} — ` +
    `${adrN} ADR + ${planN} table decisions ingestable, ${skippedStatus} skipped (status/parse).\n`);

  let created = 0, already = 0;
  for (const p of parsed) {
    // Idempotency keys on the ADR's IDENTITY (externalId), never its content. A decision is recorded
    // once per ADR, full stop — editing the ADR text must NOT spawn a new decision (that bug re-emits
    // an actively-edited ADR every sync cycle; it polluted the graph with 100+ dupes of 2 ADRs). Use
    // --force to deliberately re-ingest.
    const seen = state.ingested[p.externalId];
    const isNew = FORCE || !seen;
    const tag = isNew ? (seen ? "RE-ADD" : "NEW   ") : "have  ";
    if (!isNew) { already++; continue; }

    if (DRY) {
      console.log(`  ${tag} [${p.repo} ${p.label}] ${p.decisionSummary}`);
      console.log(`         cites → knowledge:${slugify(p.conceptTitle)}${p.rejected ? `   (over: ${p.rejected})` : ""}`);
      created++;
      continue;
    }

    // Real run: upsert the concept, then record the decision citing the slug the server returns.
    const k = await post<{ slug: string; created: boolean }>("knowledge/upsert", {
      title: p.conceptTitle, body: p.conceptBody, tags: [p.source, p.repo, p.status.split("-")[0]], project: p.repo,
    });
    const d = await post<{ knowledgeGap: boolean }>("event", {
      agentId: `${p.source}-ingest`, type: "decision", summary: p.decisionSummary,
      refs: [{ type: "informs", target: `knowledge:${k.slug}` }],
    });
    state.ingested[p.externalId] = { hash: p.contentHash, slug: k.slug, ts: Date.now() };
    console.log(`  ${tag} [${p.repo} ${p.label}] → decision cites knowledge:${k.slug}${d.knowledgeGap ? " ⚠gap" : ""}`);
    created++;
  }

  if (!DRY) saveState(state);
  console.log(`\n${DRY ? "[dry-run] would " : ""}ingest ${created} decisions · ${already} already current${DRY ? " · no writes, state untouched" : " · state saved"}.`);
}

main().catch((e) => { console.error("ingest failed:", e.message); process.exit(1); });
