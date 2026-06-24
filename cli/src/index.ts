#!/usr/bin/env bun
/**
 * focus — control the server-owned timer from the terminal (and from agents/skills).
 *
 * Uses string function refs (makeFunctionReference) so it builds without codegen.
 * After `convex dev`, optionally swap to the typed `api` from `@focus/backend/api`.
 *
 * Two auth paths during the auth rollout (FOC-25):
 *   • Agent writes (report/ask/learn/recall) → POST {FOCUS_CONVEX_SITE}/agent/* with a minted
 *     FOCUS_API_KEY (focus web → Settings → Mint key). The owner is derived from the key; no
 *     cleartext account id is carried.
 *   • Timer control + reads (status/start/…/stats/config/fleet) → the timer deployment as the
 *     owner. Until auth ships to prod these still use FOCUS_USER_ID + CONVEX_URL.
 *
 * Env: CONVEX_URL (or VITE_CONVEX_URL) — the .convex.cloud deployment (control/reads).
 *      FOCUS_USER_ID — your account id (web cookie `focus_user_id`), for control/reads.
 *      FOCUS_API_KEY — minted `ak_…` key, for agent writes.
 *      FOCUS_CONVEX_SITE — the .convex.site host for /agent/* (defaults to the keyed deployment).
 */
import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// Agent-write surface: keyed HTTP endpoints on the .convex.site host (FOC-24/25).
const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";
const FOCUS_KEY = process.env.FOCUS_API_KEY ?? "";
async function agentPost<T>(path: string, body: unknown): Promise<T> {
  if (!FOCUS_KEY) {
    console.error("Set FOCUS_API_KEY (focus web → Settings → Mint key) for agent commands.");
    process.exit(1);
  }
  const res = await fetch(`${FOCUS_SITE}/agent/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FOCUS_KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.error(`agent request failed (${res.status}): ${await res.text()}`);
    process.exit(1);
  }
  return (await res.json()) as T;
}

// String refs ("file:export") work without codegen. Swap to the typed `api` from
// `@focus/backend/api` after `convex dev` if you want arg/return type-safety here.
const q = (name: string) => makeFunctionReference<"query">(name);
const mut = (name: string) => makeFunctionReference<"mutation">(name);

const USAGE =
  "usage: focus <status|start [label]|pause|resume|skip|reset|stats|config k=v…|watch|fleet|\n" +
  "             report agent= project= [state=] [task=]|ask agent= [severity=] \"q\"|\n" +
  "             decide \"…\" [cites=knowledge:a,…]|recall \"…\"|learn \"Title\" body=…>";

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
  return s.status === "running"
    ? Math.max(0, s.remainingMs - (Date.now() - s.serverTime))
    : s.remainingMs;
}

function render(s: TimerView): string {
  const label = s.currentTaskLabel ? ` · ${s.currentTaskLabel}` : "";
  return `${PHASE[s.phase]} ${fmt(liveRemaining(s))} [${s.status}] · cycle ${s.cycleCount}/${s.config.longBreakInterval}${label}`;
}

function parseKv(args: string[]): Record<string, string> {
  return Object.fromEntries(
    args.filter((a) => a.includes("=")).map((a) => a.split("=", 2) as [string, string]),
  );
}

async function main() {
  const [cmd = "status", ...rest] = process.argv.slice(2);
  if (cmd === "help") {
    console.log(USAGE);
    return;
  }
  // Defaults to the focus.jasonv.dev deployment; override with CONVEX_URL.
  const url =
    process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? "https://perceptive-butterfly-406.convex.cloud";
  // Agent-write commands authenticate with FOCUS_API_KEY (handled by agentPost); only the
  // control/read commands need the owner id.
  const AGENT_CMDS = new Set(["report", "ask", "learn", "recall", "decide"]);
  const userId = process.env.FOCUS_USER_ID ?? "";
  if (!AGENT_CMDS.has(cmd) && !userId) {
    console.error(
      "Set FOCUS_USER_ID (your account id) for timer/fleet commands. Copy it from the web app —\n" +
        "devtools → Application → Cookies → 'focus_user_id' — or make a fresh one with: uuidgen",
    );
    process.exit(1);
  }
  const http = new ConvexHttpClient(url);

  switch (cmd) {
    case "status": {
      console.log(render((await http.query(q("timer:get"), { userId })) as TimerView));
      break;
    }
    case "start": {
      const taskLabel = rest.filter((a) => !a.includes("=")).join(" ") || undefined;
      await http.mutation(mut("timer:start"), taskLabel ? { userId, taskLabel } : { userId });
      console.log(render((await http.query(q("timer:get"), { userId })) as TimerView));
      break;
    }
    case "pause":
    case "resume":
    case "skip":
    case "reset": {
      await http.mutation(mut(`timer:${cmd}`), { userId });
      console.log(render((await http.query(q("timer:get"), { userId })) as TimerView));
      break;
    }
    case "stats": {
      const s = (await http.query(q("stats:getToday"), { userId })) as { count: number; totalMs: number };
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
      if (Object.keys(patch).length) await http.mutation(mut("config:update"), { userId, ...patch });
      console.log(JSON.stringify(await http.query(q("config:get"), { userId }), null, 2));
      break;
    }
    case "fleet": {
      const agents = (await http.query(q("fleet:list"), { userId })) as Array<{
        agentId: string; project: string; state: string; taskTitle: string | null;
      }>;
      const asks = (await http.query(q("fleet:asks"), { userId })) as {
        surfaced: Array<{ agentId: string; question?: string; severity: string }>; held: unknown[];
      };
      if (!agents.length) {
        console.log("No agents reporting.");
        break;
      }
      for (const a of agents) console.log(`· ${a.project}${a.taskTitle ? "/" + a.taskTitle : ""} — ${a.agentId} [${a.state}]`);
      for (const x of asks.surfaced) console.log(`  ! ${x.agentId}: ${x.question ?? "(needs a decision)"} [${x.severity}]`);
      console.log(`(${asks.held.length} held)`);
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
      const question = rest.filter((a) => !a.includes("=")).join(" ") || kv.q;
      if (!kv.agent) {
        console.error('usage: focus ask agent=<id> [severity=soft|hard] "your question"');
        process.exit(1);
      }
      await agentPost("ask", {
        agentId: kv.agent, severity: kv.severity ?? "soft", ...(question ? { question } : {}),
      });
      console.log(`raised ${kv.severity ?? "soft"} ask for ${kv.agent}`);
      break;
    }
    case "decide": {
      // Record a decision at a real fork, citing the knowledge that informed it (FOC-31). The
      // cited concepts become INFORMS edges in the graph — the lineage the projection exists for.
      const kv = parseKv(rest);
      const summary = rest.filter((a) => !a.includes("=")).join(" ") || kv.summary;
      if (!summary) {
        console.error('usage: focus decide "what you decided" [cites=knowledge:a,knowledge:b] [agent=<id>] [project=p]');
        process.exit(1);
      }
      const refs = (kv.cites ? kv.cites.split(",") : [])
        .map((t) => t.trim())
        .filter(Boolean)
        .map((target) => ({ type: "informs", target }));
      const r = await agentPost<{ knowledgeGap: boolean }>("event", {
        agentId: kv.agent ?? "cli",
        type: "decision",
        summary,
        refs,
      });
      console.log(`recorded decision${r.knowledgeGap ? " (⚠ no knowledge cited — add cites=knowledge:<slug>)" : ""}`);
      break;
    }
    case "recall": {
      const query = rest.filter((x) => !x.includes("=")).join(" ");
      const hits = await agentPost<Array<{ slug: string; title: string; score: number }>>(
        "knowledge/search",
        { query },
      );
      if (!hits.length) {
        console.log("No matching concepts.");
        break;
      }
      for (const h of hits) console.log(`knowledge:${h.slug} (${h.score.toFixed(2)}) — ${h.title}`);
      break;
    }
    case "learn": {
      const kv = parseKv(rest);
      const title = rest.filter((x) => !x.includes("=")).join(" ") || kv.title;
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
    case "watch": {
      // Live view — realtime push + 1s local tick. Good for an agent pacing its work.
      const client = new ConvexClient(url);
      let latest: TimerView | null = null;
      client.onUpdate(q("timer:get"), { userId }, (s) => {
        latest = s as TimerView;
      });
      setInterval(() => {
        if (latest) process.stdout.write(`\r${render(latest)}        `);
      }, 1000);
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
