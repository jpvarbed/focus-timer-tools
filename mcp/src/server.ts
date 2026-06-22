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

  // ---- fleet (attention orchestrator) ----
  server.tool(
    "focus_report",
    "Report this agent's presence to the fleet. Optional task groups agents working one workstream.",
    {
      agentId: z.string().describe("stable id for this agent/session"),
      project: z.string().describe("project the agent is working in"),
      state: z.enum(["working", "needs_you", "done"]),
      task: z.string().optional().describe("workstream title to group under"),
    },
    async ({ agentId, project, state, task }) => {
      await client.mutation(m("fleet:report"), {
        userId: opts.getUserId(), agentId, project, state, source: "mcp", ...(task ? { task } : {}),
      });
      return text(`reported ${agentId} · ${state}${task ? " · " + task : ""}`);
    },
  );
  server.tool(
    "focus_ask",
    "Raise a question for Jason. soft = can wait (held during his focus block, surfaces at his break); hard = blocked, pierces now.",
    { agentId: z.string(), question: z.string().optional(), severity: z.enum(["hard", "soft"]).default("soft") },
    async ({ agentId, question, severity }) => {
      await client.mutation(m("fleet:raiseAsk"), {
        userId: opts.getUserId(), agentId, severity, ...(question ? { question } : {}),
      });
      return text(`raised ${severity} ask for ${agentId}`);
    },
  );
  server.tool(
    "focus_event",
    "Record a provenance event. For a decision, cite knowledge in refs, e.g. {type:'informs',target:'knowledge:<id>'}.",
    {
      agentId: z.string(),
      type: z.enum(["decision", "output", "handoff", "ask_answered"]),
      summary: z.string(),
      reasoning: z.string().optional(),
      refs: z.array(z.object({ type: z.string(), target: z.string() })).optional(),
    },
    async ({ agentId, type, summary, reasoning, refs }) => {
      const r = (await client.mutation(m("fleet:recordEvent"), {
        userId: opts.getUserId(), agentId, type, summary, reasoning, refs: refs ?? [],
      })) as { knowledgeGap: boolean };
      return text(`recorded ${type}: ${summary}${r.knowledgeGap ? " (⚠ no knowledge cited)" : ""}`);
    },
  );
  server.tool("focus_fleet", "Show the fleet: agents grouped by project/task + open asks.", {}, async () => {
    const agents = (await client.query(q("fleet:list"), { userId: opts.getUserId() })) as Array<{
      agentId: string; project: string; state: string; taskTitle: string | null;
    }>;
    const asks = (await client.query(q("fleet:asks"), { userId: opts.getUserId() })) as {
      surfaced: Array<{ agentId: string; question?: string; severity: string }>; held: unknown[];
    };
    if (agents.length === 0) return text("No agents reporting.");
    const lines = agents.map((a) => `· ${a.project}${a.taskTitle ? "/" + a.taskTitle : ""} — ${a.agentId} [${a.state}]`);
    const asky = asks.surfaced.map((x) => `  ! ${x.agentId}: ${x.question ?? "(needs a decision)"} [${x.severity}]`);
    return text([...lines, ...(asky.length ? ["asks needing you:", ...asky] : []), `(${asks.held.length} held)`].join("\n"));
  });

  return server;
}
