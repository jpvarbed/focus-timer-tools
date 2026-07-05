#!/usr/bin/env bun
/**
 * distill — extract material decisions from an agent session transcript into the focus graph (FOC-41).
 *
 * The structured rungs (ADRs, PLAN tables, council) capture the decisions that get written down. This
 * captures the ones that DON'T: the in-flight calls made mid-session. It reads a Claude Code transcript
 * (`.jsonl`), strips it to the actual conversation (user directives + assistant reasoning — tool spam
 * dropped), and asks an LLM to pull out each real decision as {what, why, rejected, principle, who,
 * evidence}. --write lands them as `learn` + `decide cites=` (deduped server-side, FOC-39).
 *
 * PRECISION-FIRST (the cardinal rule): a fabricated decision poisons the corpus worse than a missed one.
 * Every extraction must quote a transcript span; unquotable → dropped. Materiality bar pinned 2026-07-05
 * (see notes/specs/foc-41-transcript-distiller.md).
 *
 * Env: GOOGLE_API_KEY (extraction) · FOCUS_API_KEY + FOCUS_CONVEX_SITE (only for --write).
 * Usage: bun scripts/distill.ts <transcript.jsonl> [--write] [--model gemini-2.5-flash] [--chunk 100000]
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WRITE = argv.includes("--write");
const MODEL = flag("--model", "gemini-2.5-flash");
const CHUNK = parseInt(flag("--chunk", "100000"), 10);
const FILE = argv.find((a) => !a.startsWith("--") && a !== MODEL && a !== String(CHUNK));
const GKEY = process.env.GOOGLE_API_KEY ?? "";
const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";
const FOCUS_KEY = process.env.FOCUS_API_KEY ?? "";

const SECRET_RE = /\bak_[0-9a-zA-Z]{20,}|\bre_[0-9a-zA-Z]|BWS_ACCESS_TOKEN|-----BEGIN|xoxb-|ghp_|gho_/;

// ---- transcript → clean conversation (drop tool_use/tool_result/attachments/system spam) ----
function cleanTranscript(jsonl: string): string {
  const turns: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== "user" && d.type !== "assistant") continue;
    const content = d.message?.content;
    let text = "";
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === "text" && typeof b.text === "string") text += b.text + "\n";
        // tool_use / tool_result carry mechanics, not reasoning — skip them.
      }
    }
    text = text.trim();
    if (!text) continue;
    // skip injected harness noise that isn't real conversation
    if (text.startsWith("<system-reminder>") || text.startsWith("Caveat:")) continue;
    turns.push(`### ${d.type}\n${text}`);
  }
  return turns.join("\n\n");
}

function chunkByTurns(convo: string, max: number): string[] {
  const turns = convo.split("\n\n### ");
  const chunks: string[] = [];
  let cur = "";
  for (let t of turns) {
    if (!t.startsWith("###")) t = "### " + t;
    if (cur.length + t.length > max && cur) { chunks.push(cur); cur = ""; }
    cur += (cur ? "\n\n" : "") + t;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

const RUBRIC = `You extract MATERIAL DECISIONS from a coding-agent session transcript, to build an exo-brain
that lets an agent make the calls this person (Jason) would make. Precision matters far more than recall:
a fabricated decision is worse than a missed one.

A DECISION is a choice about WHAT or HOW to build/operate/ship — an architecture, tool, API, design,
tradeoff, scope cut, or strategy call ("ship to prod now", "dedupe now instead of waiting"). The
rejected alternative must be a SUBSTANTIVE, DIFFERENT approach that was genuinely on the table.

HARD EXCLUSIONS — these are NOT decisions, never emit them:
- The agent narrating its own WORKFLOW: investigating, debugging, reading code, tracing, verifying,
  testing, diagnosing, "let me look at X", "let me confirm Y", cleaning up, git stash/rebase/push,
  removing test data, sequencing ("do X first"). This is HOW the work got done, not a fork in the product.
- Any "decision" whose rejected alternative is just the NEGATION of the action — "not doing it",
  "leaving it as-is", "assuming without checking", "continuing to X", "not proceeding". A trivial
  negation means there was no real fork → OMIT it. This is the #1 false-positive pattern; be ruthless.
- Mechanical/incidental picks (variable names, buffer sizes, clamp values, which command to run).

Precision over recall: when unsure whether something is a real product/architecture/strategy decision
with a genuine competing alternative, OMIT it. Better to miss one than fabricate one.

ATTRIBUTION: label who ORIGINATED the choice. If the agent recommended X and Jason just approved ("yeah
do it", "sounds good"), who = "agent-endorsed" — NOT "human". Use "human" only when Jason specified the
actual choice himself.

For each decision return:
- what: the decision, one line (what was chosen).
- why: the reason it was chosen (from the transcript, not invented).
- rejected: the alternative not taken (or "" if none was named/implied).
- principle: the generalizable rule it reveals (e.g. "idempotency keys on identity, not mutable content")
  ONLY if clearly stated or strongly implied; else null. NEVER invent a principle.
- principle_confidence: "high" | "low" | null (null when principle is null).
- who: "human" (Jason directed it) | "agent" (the assistant decided) | "agent-endorsed" (agent decided, Jason blessed it).
- evidence: a SHORT verbatim quote (<=160 chars) from the transcript that supports this decision. If you
  cannot quote supporting text, DO NOT emit the decision. This is mandatory.

Return ONLY the decisions that clear this bar.`;

async function extract(chunk: string): Promise<any[]> {
  const schema = {
    type: "array",
    items: {
      type: "object",
      properties: {
        what: { type: "string" }, why: { type: "string" }, rejected: { type: "string" },
        principle: { type: "string", nullable: true }, principle_confidence: { type: "string", nullable: true },
        who: { type: "string" }, evidence: { type: "string" },
      },
      required: ["what", "why", "rejected", "who", "evidence"],
    },
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GKEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: RUBRIC }] },
        contents: [{ role: "user", parts: [{ text: `TRANSCRIPT CHUNK:\n\n${chunk}` }] }],
        generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.1 },
      }),
    },
  );
  if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as any;
  const txt = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  try { return JSON.parse(txt); } catch { return []; }
}

async function agentPost(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${FOCUS_SITE}/agent/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FOCUS_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  if (!FILE) { console.error("usage: distill <transcript.jsonl> [--write]"); process.exit(1); }
  if (!GKEY) { console.error("GOOGLE_API_KEY not set (bws)."); process.exit(1); }
  if (WRITE && !FOCUS_KEY) { console.error("--write needs FOCUS_API_KEY."); process.exit(1); }

  const convo = cleanTranscript(readFileSync(FILE, "utf8"));
  const chunks = chunkByTurns(convo, CHUNK);
  console.error(`transcript → ${convo.length} chars of conversation → ${chunks.length} chunk(s)`);

  const all: any[] = [];
  for (let i = 0; i < chunks.length; i++) {
    process.stderr.write(`  extracting chunk ${i + 1}/${chunks.length}…\n`);
    try { all.push(...(await extract(chunks[i]))); } catch (e: any) { console.error(`  chunk ${i + 1} failed: ${e.message}`); }
  }

  // anti-hallucination + secret gates
  const kept = all.filter((d) => {
    if (!d.what || !d.evidence || d.evidence.length < 8) return false; // must quote evidence
    const blob = JSON.stringify(d);
    if (SECRET_RE.test(blob)) return false; // never write a secret into the graph
    return true;
  });

  console.log(`\n=== ${kept.length} material decisions (of ${all.length} raw) ===\n`);
  for (const d of kept) {
    const p = d.principle ? `  ⟶ ${d.principle}${d.principle_confidence === "low" ? " (low-conf)" : ""}` : "";
    console.log(`• [${d.who}] ${d.what}`);
    if (d.rejected) console.log(`    over: ${d.rejected}`);
    if (p) console.log(p);
    console.log(`    ⌜${d.evidence.slice(0, 120)}⌟`);
  }

  if (!WRITE) { console.log(`\n[dry-run] ${kept.length} would be written. Pass --write to land them.`); return; }

  let wrote = 0;
  for (const d of kept) {
    const body = [d.why && `Why: ${d.why}`, d.rejected && `Rejected: ${d.rejected}`, d.principle && `Principle: ${d.principle}`]
      .filter(Boolean).join("\n");
    const k = await agentPost("knowledge/upsert", { title: d.what, body: body || d.what, tags: ["distilled", d.who], project: "session" });
    await agentPost("event", { agentId: "distill", type: "decision", summary: d.what, refs: [{ type: "informs", target: `knowledge:${k.slug}` }] });
    wrote++;
  }
  console.log(`\nwrote ${wrote} decisions to the graph (deduped server-side).`);
}

main().catch((e) => { console.error("distill failed:", e.message); process.exit(1); });
