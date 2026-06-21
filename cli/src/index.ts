#!/usr/bin/env bun
/**
 * focus — control the server-owned timer from the terminal (and from agents/skills).
 *
 * Uses string function refs (makeFunctionReference) so it builds without codegen.
 * After `convex dev`, optionally swap to the typed `api` from `@focus/backend/api`.
 *
 * Env: CONVEX_URL (or VITE_CONVEX_URL) — the deployment URL.
 *      FOCUS_USER_ID — your account id (copy the web's localStorage `focus_user_id` to
 *      drive the same timer, or use a fresh value for a separate one).
 */
import { ConvexHttpClient, ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// String refs ("file:export") work without codegen. Swap to the typed `api` from
// `@focus/backend/api` after `convex dev` if you want arg/return type-safety here.
const q = (name: string) => makeFunctionReference<"query">(name);
const mut = (name: string) => makeFunctionReference<"mutation">(name);

const USAGE =
  "usage: focus <status|start [label]|pause|resume|skip|reset|stats|config k=v…|watch>";

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
    process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL ?? "https://vivid-ant-124.convex.cloud";
  const userId = process.env.FOCUS_USER_ID ?? "";
  if (!userId) {
    console.error(
      "Set FOCUS_USER_ID (your account id). Copy it from the web app — devtools →\n" +
        "Application → Cookies → 'focus_user_id' — or make a fresh one with: uuidgen",
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
