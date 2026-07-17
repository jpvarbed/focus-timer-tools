#!/usr/bin/env bun
/**
 * focus — control the server-owned timer + report into the fleet, from the terminal.
 *
 * Every command authenticates with a minted **FOCUS_API_KEY** (`ak_…`, focus web → Settings →
 * Mint key) against the keyed HTTP layer at `$FOCUS_CONVEX_SITE/agent/*`. The owner is derived from
 * the key server-side — no cleartext account id.
 *
 * Env: FOCUS_API_KEY (required) · FOCUS_CONVEX_SITE (defaults to the prod deployment's .convex.site).
 */
import {
  FocusHttpClient,
  collectFactoryRun,
  collectFileDecision,
  collectorStatus,
  deriveRepositoryScope,
  readLocalReceipt,
  resolveDecisionTarget,
  syncPending,
} from "../../memory/pipeline";

const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";
const FOCUS_KEY = process.env.FOCUS_API_KEY ?? "";

function requireKey(): void {
  if (!FOCUS_KEY) {
    console.error("Set FOCUS_API_KEY (focus web → Settings → Mint key).");
    process.exit(1);
  }
}
async function agentPost<T>(path: string, body: unknown): Promise<T> {
  requireKey();
  const res = await fetch(`${FOCUS_SITE}/agent/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FOCUS_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.error(`agent request failed (${res.status}): ${await res.text()}`); process.exit(1); }
  return (await res.json()) as T;
}
async function agentGet<T>(path: string): Promise<T> {
  requireKey();
  const res = await fetch(`${FOCUS_SITE}/agent/${path}`, { headers: { Authorization: `Bearer ${FOCUS_KEY}` } });
  if (!res.ok) { console.error(`agent request failed (${res.status}): ${await res.text()}`); process.exit(1); }
  return (await res.json()) as T;
}

const USAGE =
  "usage: focus <status|start [label]|pause|resume|skip|reset|stats|config k=v…|watch|fleet|\n" +
  "             report agent= project= [state=] [task=]|ask agent= [severity=] \"q\"|\n" +
  "             decide \"…\" [cites=knowledge:a,…]|recall \"…\"|learn \"Title\" body=…|\n" +
  "             collect decision|factory-run …|sync|recall-decisions query=…|\n" +
  "             collector-status|receipt <envelopeId>>";

type TimerView = {
  phase: "focus" | "short_break" | "long_break";
  status: "idle" | "running" | "paused";
  remainingMs: number;
  serverTime: number;
  cycleCount: number;
  currentTaskLabel: string | null;
  version: number;
  config: { longBreakInterval: number };
};

const PHASE = { focus: "Focus", short_break: "Break", long_break: "Long break" } as const;
function fmt(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
function liveRemaining(s: TimerView): number {
  return s.status === "running" ? Math.max(0, s.remainingMs - (Date.now() - s.serverTime)) : s.remainingMs;
}
function render(s: TimerView): string {
  const label = s.currentTaskLabel ? ` · ${s.currentTaskLabel}` : "";
  return `${PHASE[s.phase]} ${fmt(liveRemaining(s))} [${s.status}] · cycle ${s.cycleCount}/${s.config.longBreakInterval}${label}`;
}
const timer = () => agentGet<TimerView>("timer");

// A CLI flag is `key=value` (a bare word then '='). Free text that merely contains '=' — e.g. a
// decision summary "Provenance = hybrid" — is NOT a flag, so match only a leading `word=`.
const isFlag = (a: string) => /^[a-zA-Z][\w-]*=/.test(a);
function parseKv(args: string[]): Record<string, string> {
  return Object.fromEntries(args.filter(isFlag).map((argument) => {
    const separator = argument.indexOf("=");
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }));
}

function confirmed(args: string[], kv: Record<string, string>): boolean {
  return args.includes("--confirm") || kv.confirm === "true";
}

function lineRange(kv: Record<string, string>): { lineStart: number; lineEnd: number } {
  const parts = kv.lines?.split(":");
  const lineStart = Number(kv.lineStart ?? parts?.[0]);
  const lineEnd = Number(kv.lineEnd ?? parts?.[1] ?? parts?.[0]);
  if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd)) {
    throw new Error("collect decision requires lines=<start>:<end>");
  }
  return { lineStart, lineEnd };
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  if (cmd === "help") { console.log(USAGE); return; }

  switch (cmd) {
    case "status": {
      console.log(render(await timer()));
      break;
    }
    case "start": {
      const taskLabel = rest.filter((a) => !isFlag(a)).join(" ") || undefined;
      await agentPost("timer/start", taskLabel ? { taskLabel } : {});
      console.log(render(await timer()));
      break;
    }
    case "pause":
    case "resume":
    case "skip":
    case "reset": {
      await agentPost(`timer/${cmd}`, {});
      console.log(render(await timer()));
      break;
    }
    case "stats": {
      const s = await agentGet<{ count: number; totalMs: number }>("stats");
      console.log(`Today: ${s.count} focus sessions · ${Math.round(s.totalMs / 60000)} min`);
      break;
    }
    case "config": {
      const kv = parseKv(rest);
      const patch: Record<string, number | boolean> = {};
      if (kv.focus) patch.focusMin = Number(kv.focus);
      if (kv.short) patch.shortBreakMin = Number(kv.short);
      if (kv.long) patch.longBreakMin = Number(kv.long);
      if (kv.interval) patch.longBreakInterval = Number(kv.interval);
      if (kv.autostart) patch.autoStart = kv.autostart === "true";
      if (Object.keys(patch).length) await agentPost("config", patch);
      console.log(JSON.stringify(await agentGet("config"), null, 2));
      break;
    }
    case "fleet": {
      const { agents, asks } = await agentGet<{
        agents: Array<{ agentId: string; project: string; state: string; taskTitle: string | null; activity: string | null }>;
        asks: { surfaced: Array<{ agentId: string; question?: string; severity: string }>; held: unknown[] };
      }>("fleet");
      const live = agents.filter((a) => a.state !== "done");
      if (!live.length) { console.log("No agents reporting."); break; }
      for (const a of live) console.log(`· ${a.project}${a.taskTitle ? "/" + a.taskTitle : ""} — ${a.agentId} [${a.state}]${a.activity ? " · " + a.activity : ""}`);
      for (const x of asks.surfaced) console.log(`  ! ${x.agentId}: ${x.question ?? "(needs a decision)"} [${x.severity}]`);
      console.log(`(${asks.held.length} held · ${agents.length - live.length} done)`);
      break;
    }
    case "report": {
      const kv = parseKv(rest);
      if (!kv.agent || !kv.project) {
        console.error("usage: focus report agent=<id> project=<name> [state=working|needs_you|done] [task=<title>]");
        process.exit(1);
      }
      await agentPost("report", {
        agentId: kv.agent, project: kv.project, state: kv.state ?? "working", source: "cli",
        ...(kv.task ? { task: kv.task } : {}),
      });
      console.log(`reported ${kv.agent} · ${kv.state ?? "working"}`);
      break;
    }
    case "ask": {
      const kv = parseKv(rest);
      const question = rest.filter((a) => !isFlag(a)).join(" ") || kv.q;
      if (!kv.agent) {
        console.error('usage: focus ask agent=<id> [severity=soft|hard] "your question"');
        process.exit(1);
      }
      await agentPost("ask", { agentId: kv.agent, severity: kv.severity ?? "soft", ...(question ? { question } : {}) });
      console.log(`raised ${kv.severity ?? "soft"} ask for ${kv.agent}`);
      break;
    }
    case "decide": {
      // Record a decision at a real fork, citing the knowledge that informed it (FOC-31). Cited
      // concepts become INFORMS edges in the graph — the lineage the projection exists for.
      const kv = parseKv(rest);
      const summary = rest.filter((a) => !isFlag(a)).join(" ") || kv.summary;
      if (!summary) {
        console.error('usage: focus decide "what you decided" [cites=knowledge:a,knowledge:b] [agent=<id>]');
        process.exit(1);
      }
      const refs = (kv.cites ? kv.cites.split(",") : []).map((t) => t.trim()).filter(Boolean)
        .map((target) => ({ type: "informs", target }));
      const r = await agentPost<{ knowledgeGap: boolean }>("event", { agentId: kv.agent ?? "cli", type: "decision", summary, refs });
      console.log(`recorded decision${r.knowledgeGap ? " (⚠ no knowledge cited — add cites=knowledge:<slug>)" : ""}`);
      break;
    }
    case "recall": {
      const query = rest.filter((x) => !isFlag(x)).join(" ");
      const hits = await agentPost<Array<{ slug: string; title: string; score: number }>>("knowledge/search", { query });
      if (!hits.length) { console.log("No matching concepts."); break; }
      for (const h of hits) console.log(`knowledge:${h.slug} (${h.score.toFixed(2)}) — ${h.title}`);
      break;
    }
    case "learn": {
      const kv = parseKv(rest);
      const title = rest.filter((x) => !isFlag(x)).join(" ") || kv.title;
      if (!title || !kv.body) {
        console.error('usage: focus learn "Title" body="..." [tags=a,b] [project=p]');
        process.exit(1);
      }
      const r = await agentPost<{ slug: string; created: boolean; reason?: string }>("knowledge/upsert", {
        title, body: kv.body,
        ...(kv.tags ? { tags: kv.tags.split(",") } : {}),
        ...(kv.project ? { project: kv.project } : {}),
      });
      console.log(`${r.created ? "created" : "reused (" + r.reason + ")"} -> knowledge:${r.slug}`);
      break;
    }
    case "collect": {
      const [collector, ...collectorArgs] = rest;
      const kv = parseKv(collectorArgs);
      const spoolRoot = kv.spool;
      if (collector === "decision") {
        if (!kv.file) throw new Error("collect decision requires file=<path>");
        const action = (kv.action ?? "create") as "create" | "correct" | "tombstone";
        if (!["create", "correct", "tombstone"].includes(action)) throw new Error("invalid decision action");
        const target = resolveDecisionTarget({
          action,
          ...(spoolRoot ? { spoolRoot } : {}),
          ...(kv.receipt ? { priorEnvelopeId: kv.receipt } : {}),
          ...(kv.assertionId ? { assertionId: kv.assertionId } : {}),
          ...(kv.expectedActiveRevisionId ? { expectedActiveRevisionId: kv.expectedActiveRevisionId } : {}),
        });
        const envelope = await collectFileDecision({
          cwd: kv.cwd ?? process.cwd(),
          file: kv.file,
          ...lineRange(kv),
          ...target,
          ...(kv.text ? { text: kv.text } : {}),
          actor: kv.actor ?? "cli",
          ...(kv.project ? { project: kv.project } : {}),
          confirmed: confirmed(collectorArgs, kv),
          ...(spoolRoot ? { spoolRoot } : {}),
        });
        console.log(JSON.stringify(envelope, null, 2));
      } else if (collector === "factory-run") {
        if (!kv.receipt) throw new Error("collect factory-run requires receipt=<path>");
        const envelope = await collectFactoryRun({
          receiptPath: kv.receipt,
          actor: kv.actor ?? "factory-droid",
          ...(kv.project ? { project: kv.project } : {}),
          confirmed: confirmed(collectorArgs, kv),
          ...(spoolRoot ? { spoolRoot } : {}),
        });
        console.log(JSON.stringify(envelope, null, 2));
      } else {
        throw new Error("usage: focus collect <decision|factory-run> ...");
      }
      break;
    }
    case "sync": {
      const kv = parseKv(rest);
      const client = new FocusHttpClient(FOCUS_SITE, FOCUS_KEY);
      console.log(JSON.stringify(await syncPending({
        ...(kv.spool ? { spoolRoot: kv.spool } : {}),
        loader: client,
        bindOwner: kv["bind-owner"] === "true",
      }), null, 2));
      break;
    }
    case "recall-decisions": {
      const kv = parseKv(rest);
      const queryText = kv.query ?? rest.filter((arg) => !isFlag(arg)).join(" ");
      if (!queryText) throw new Error("recall-decisions requires query=<text>");
      const scope = deriveRepositoryScope(kv.cwd ?? process.cwd());
      const hits = await new FocusHttpClient(FOCUS_SITE, FOCUS_KEY).searchDecisions({
        ...scope,
        queryText,
        ...(kv.limit ? { limit: Number(kv.limit) } : {}),
      });
      if (!hits.length) console.log("No matching decisions in this repository and branch.");
      for (const hit of hits) {
        console.log(
          `${hit.assertionId}@${hit.revisionId} — ${hit.text}\n` +
            `  ${hit.repository}/${hit.branch}:${hit.source.repoRelativePath}:${hit.source.lineStart}-${hit.source.lineEnd} ` +
            `(${hit.source.sourceVersion.slice(0, 12)}, sha256:${hit.source.sha256.slice(0, 12)})`,
        );
      }
      break;
    }
    case "collector-status": {
      const kv = parseKv(rest);
      console.log(JSON.stringify(collectorStatus(kv.spool), null, 2));
      break;
    }
    case "receipt": {
      const kv = parseKv(rest);
      const envelopeId = rest.find((arg) => !isFlag(arg) && !arg.startsWith("--"));
      if (!envelopeId) throw new Error("receipt requires an envelope id");
      const local = readLocalReceipt(kv.spool, envelopeId);
      const receipt = local ?? (await new FocusHttpClient(FOCUS_SITE, FOCUS_KEY).receipt(envelopeId));
      if (!receipt) throw new Error(`receipt not found: ${envelopeId}`);
      console.log(JSON.stringify(receipt, null, 2));
      break;
    }
    case "watch": {
      // Live view — polls the keyed timer every second. Good for an agent pacing its work.
      const tick = async () => process.stdout.write(`\r${render(await timer())}        `);
      await tick();
      setInterval(tick, 1000);
      break;
    }
    default:
      console.log(USAGE);
      process.exit(1);
  }

  if (cmd !== "watch") process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
