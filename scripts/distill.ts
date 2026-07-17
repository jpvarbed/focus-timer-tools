#!/usr/bin/env bun
/**
 * distill — extract material decisions from an agent session transcript into the focus graph (FOC-41).
 *
 * Originally an LLM extractor; converted to a DETERMINISTIC, quote-based extractor under FOC-40 /
 * JAS-236: no model participates in ETL. Classification that cannot be done deterministically stays
 * a pending candidate for explicit human/agent confirmation; nothing is guessed by a model.
 *
 * It reads a Claude Code transcript (`.jsonl`), strips it to the actual conversation (user directives
 * + assistant reasoning — tool spam dropped), and surfaces candidate decision turns via lexical fork
 * patterns. Every candidate carries a verbatim transcript quote; unquotable → dropped (precision-first).
 * It never writes memory. Confirm a real decision against a repository file with
 * `focus collect decision ... confirm=true`; the Focus loader owns lifecycle.
 *
 * PRECISION-FIRST (the cardinal rule): a fabricated decision poisons the corpus worse than a missed one.
 * A deterministic extractor errs toward MISSING decisions (low recall) rather than fabricating them.
 *
 * Usage: bun scripts/distill.ts <transcript.jsonl> [--chunk 100000]
 */
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const WRITE = argv.includes("--write");
const CHUNK = parseInt(flag("--chunk", "100000"), 10);
const FILE = argv.find((a) => !a.startsWith("--") && a !== String(CHUNK));

const SECRET_RE = /\bak_[0-9a-zA-Z]{20,}|\bre_[0-9a-zA-Z]|BWS_ACCESS_TOKEN|-----BEGIN|xoxb-|ghp_|gho_/;

// Lexical fork signals — a turn is a candidate decision if it contains one of these choice patterns.
// Deliberately narrow: mechanical/workflow verbs ("let me check", "fix the regex") are NOT here.
const FORK_PATTERNS: RegExp[] = [
  /\b(let'?s|lets|we(?:'ll| will| should|'d)|I(?:'ll| will| should|'d))\b.*\b(use|go with|pick|choose|adopt|switch (?:to|from)|replace|drop|keep|avoid|prefer|ship|land|cut|scope|name|call it)\b/i,
  /\binstead of\b/i,
  /\brather than\b/i,
  /\bover\b.*\b(as an? option|alternative|approach|option)\b/i,
  /\bdecide[ds]?\b/i,
  /\bdecision\b/i,
  /\btrade-?off\b/i,
];

// Exclusions — workflow/mechanics narration that is NOT a product fork, even if it matches a fork word.
const EXCLUDE_PATTERNS: RegExp[] = [
  /\b(let me|let'?s (?:check|confirm|look|see|run|verify|test|debug|trace|inspect|read))\b/i,
  /\b(stash|rebase|commit|push|merge|cherry-pick|checkout|pull)\b/i,
  /\bfix (?:the |a |this )?[a-z]/i,
  /\bcorrect(?:ing|ed)? (?:the |a |this )?[a-z]/i,
];

function isFork(text: string): boolean {
  if (EXCLUDE_PATTERNS.some((re) => re.test(text))) return false;
  return FORK_PATTERNS.some((re) => re.test(text));
}

// ---- transcript → clean conversation (drop tool_use/tool_result/attachments/system spam) ----
export function cleanTranscript(jsonl: string): string {
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
    if (text.startsWith("<system-reminder>") || text.startsWith("Caveat:")) continue;
    turns.push(`### ${d.type}\n${text}`);
  }
  return turns.join("\n\n");
}

type Candidate = {
  who: "human" | "agent";
  what: string;
  evidence: string;
};

/** Deterministic extraction: a turn is a candidate decision iff it carries a lexical fork signal and
 *  is not workflow narration. The "what" is the first sentence of the turn; the "evidence" is a
 *  verbatim quote of the matching line. No model, no guessing. */
export function extract(convo: string): Candidate[] {
  const out: Candidate[] = [];
  for (const block of convo.split(/\n\n### /)) {
    const lines = block.split("\n");
    const header = lines[0] ?? "";
    const role = header.trim().replace(/^###\s+/, "");
    const who: "human" | "agent" = role === "user" ? "human" : "agent";
    const body = lines.slice(1).join("\n").trim();
    if (!body) continue;
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t.length < 8) continue;
      if (isFork(t)) {
        const what = t.split(/[.!?]/)[0]!.trim().slice(0, 160) || t.slice(0, 160);
        out.push({ who, what, evidence: t.slice(0, 160) });
        break; // one candidate per turn — the first fork line is the strongest signal
      }
    }
  }
  return out;
}

async function main() {
  if (!FILE) { console.error("usage: distill <transcript.jsonl>"); process.exit(1); }
  if (WRITE) {
    throw new Error("--write is retired: transcript candidates are not durable memory; use focus collect decision with a source file");
  }

  const convo = cleanTranscript(readFileSync(FILE, "utf8"));
  console.error(`transcript → ${convo.length} chars of conversation`);

  const all = extract(convo);

  // anti-hallucination + secret gates
  const kept = all.filter((d) => {
    if (!d.what || d.evidence.length < 8) return false;
    const blob = JSON.stringify(d);
    if (SECRET_RE.test(blob)) return false;
    return true;
  });

  console.log(`\n=== ${kept.length} candidate decisions (deterministic, pending confirmation) ===\n`);
  for (const d of kept) {
    console.log(`• [${d.who}] ${d.what}`);
    console.log(`    ⌜${d.evidence.slice(0, 120)}⌟`);
  }

  console.log(
    `\n[dry-run] ${kept.length} candidates only. Durable memory requires an explicit, source-cited file-decision envelope.`,
  );
}

if (import.meta.main) {
  main().catch((e) => { console.error("distill failed:", e.message); process.exit(1); });
}
