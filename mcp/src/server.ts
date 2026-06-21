import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

// The focus.jasonv.dev Convex deployment (public client URL). Override with CONVEX_URL.
export const DEFAULT_CONVEX_URL = "https://perceptive-butterfly-406.convex.cloud";

const q = (name: string) => makeFunctionReference<"query">(name);
const m = (name: string) => makeFunctionReference<"mutation">(name);

type TimerView = {
  phase: "focus" | "short_break" | "long_break";
  status: "idle" | "running" | "paused";
  remainingMs: number;
  serverTime: number;
  cycleCount: number;
  currentTaskLabel: string | null;
  config: { longBreakInterval: number };
};

const PHASE = { focus: "Focus", short_break: "Break", long_break: "Long break" } as const;

function fmt(ms: number): string {
  const t = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`;
}
function render(s: TimerView): string {
  const live = s.status === "running" ? Math.max(0, s.remainingMs - (Date.now() - s.serverTime)) : s.remainingMs;
  const label = s.currentTaskLabel ? ` · ${s.currentTaskLabel}` : "";
  return `${PHASE[s.phase]} ${fmt(live)} [${s.status}] · cycle ${s.cycleCount}/${s.config.longBreakInterval}${label}`;
}

/** Build the focus-timer MCP server. `getUserId` resolves the caller's account id per request. */
export function buildServer(opts: { convexUrl?: string; getUserId: () => string }) {
  const client = new ConvexHttpClient(opts.convexUrl ?? DEFAULT_CONVEX_URL);
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const status = async () =>
    render((await client.query(q("timer:get"), { userId: opts.getUserId() })) as TimerView);

  const server = new McpServer({ name: "focus-timer", version: "0.1.0" });

  server.tool("focus_status", "Show the current focus/break timer.", {}, async () => text(await status()));

  server.tool(
    "focus_start",
    "Start a focus session.",
    { taskLabel: z.string().optional().describe("what you're focusing on") },
    async ({ taskLabel }) => {
      await client.mutation(
        m("timer:start"),
        taskLabel ? { userId: opts.getUserId(), taskLabel } : { userId: opts.getUserId() },
      );
      return text(await status());
    },
  );

  for (const cmd of ["pause", "resume", "skip", "reset"] as const) {
    server.tool(`focus_${cmd}`, `${cmd.charAt(0).toUpperCase()}${cmd.slice(1)} the timer.`, {}, async () => {
      await client.mutation(m(`timer:${cmd}`), { userId: opts.getUserId() });
      return text(await status());
    });
  }

  server.tool("focus_stats", "Today's completed-focus count and total minutes.", {}, async () => {
    const s = (await client.query(q("stats:getToday"), { userId: opts.getUserId() })) as {
      count: number;
      totalMs: number;
    };
    return text(`Today: ${s.count} focus sessions · ${Math.round(s.totalMs / 60000)} min`);
  });

  return server;
}
