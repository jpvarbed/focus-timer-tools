// Remote (HTTP) MCP endpoint for the focus timer — a stateless Streamable-HTTP transport,
// deployed as a Vercel function so it has a callable URL (for ARD discovery).
// Timer control/read tools identify the caller via the `x-focus-user` header; agent-write tools
// (report/ask/event/recall/learn) authenticate with a minted key via `Authorization: Bearer ak_…`.
//
// Self-contained on purpose (no cross-workspace import) so the serverless bundle is simple.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const DEFAULT_CONVEX_URL = "https://perceptive-butterfly-406.convex.cloud";
const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://vivid-ant-124.convex.site";
const q = (name: string) => makeFunctionReference<"query">(name);
const m = (name: string) => makeFunctionReference<"mutation">(name);

/** POST an agent write to the keyed HTTP layer; the owner is derived from `key`, not the body. */
async function agentPost<T>(key: string, path: string, body: unknown): Promise<T> {
  if (!key) throw new Error("Pass a minted key via Authorization: Bearer ak_… for agent tools.");
  const res = await fetch(`${FOCUS_SITE}/agent/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`agent request failed (${res.status}): ${await res.text()}`);
  return (await res.json()) as T;
}

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

function buildServer(userId: string, apiKey: string) {
  const client = new ConvexHttpClient(process.env.CONVEX_URL ?? DEFAULT_CONVEX_URL);
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
  const status = async () => render((await client.query(q("timer:get"), { userId })) as TimerView);

  const server = new McpServer({ name: "focus-timer", version: "0.1.0" });
  server.tool("focus_status", "Show the current focus/break timer.", {}, async () => text(await status()));
  server.tool(
    "focus_start",
    "Start a focus session.",
    { taskLabel: z.string().optional().describe("what you're focusing on") },
    async ({ taskLabel }) => {
      await client.mutation(m("timer:start"), taskLabel ? { userId, taskLabel } : { userId });
      return text(await status());
    },
  );
  for (const cmd of ["pause", "resume", "skip", "reset"] as const) {
    server.tool(`focus_${cmd}`, `${cmd.charAt(0).toUpperCase()}${cmd.slice(1)} the timer.`, {}, async () => {
      await client.mutation(m(`timer:${cmd}`), { userId });
      return text(await status());
    });
  }
  server.tool("focus_stats", "Today's completed-focus count and total minutes.", {}, async () => {
    const s = (await client.query(q("stats:getToday"), { userId })) as { count: number; totalMs: number };
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
      await agentPost(apiKey, "report", { agentId, project, state, source: "mcp", ...(task ? { task } : {}) });
      return text(`reported ${agentId} · ${state}${task ? " · " + task : ""}`);
    },
  );
  server.tool(
    "focus_ask",
    "Raise a question for Jason. soft = can wait (held during his focus block, surfaces at his break); hard = blocked, pierces now.",
    { agentId: z.string(), question: z.string().optional(), severity: z.enum(["hard", "soft"]).default("soft") },
    async ({ agentId, question, severity }) => {
      await agentPost(apiKey, "ask", { agentId, severity, ...(question ? { question } : {}) });
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
      const r = await agentPost<{ knowledgeGap: boolean }>(apiKey, "event", {
        agentId, type, summary, reasoning, refs: refs ?? [],
      });
      return text(`recorded ${type}: ${summary}${r.knowledgeGap ? " (⚠ no knowledge cited)" : ""}`);
    },
  );
  server.tool("focus_fleet", "Show the fleet: agents grouped by project/task + open asks.", {}, async () => {
    const agents = (await client.query(q("fleet:list"), { userId })) as Array<{
      agentId: string; project: string; state: string; taskTitle: string | null;
    }>;
    const asks = (await client.query(q("fleet:asks"), { userId })) as {
      surfaced: Array<{ agentId: string; question?: string; severity: string }>; held: unknown[];
    };
    if (agents.length === 0) return text("No agents reporting.");
    const lines = agents.map((a) => `· ${a.project}${a.taskTitle ? "/" + a.taskTitle : ""} — ${a.agentId} [${a.state}]`);
    const asky = asks.surfaced.map((x) => `  ! ${x.agentId}: ${x.question ?? "(needs a decision)"} [${x.severity}]`);
    return text([...lines, ...(asky.length ? ["asks needing you:", ...asky] : []), `(${asks.held.length} held)`].join("\n"));
  });

  // ---- knowledge (semantic) ----
  server.tool(
    "focus_recall",
    "Semantic search Jason's knowledge concepts. Use BEFORE making a decision to find prior knowledge to cite (knowledge:<slug>).",
    { query: z.string(), limit: z.number().optional() },
    async ({ query, limit }) => {
      const hits = await agentPost<Array<{ slug: string; title: string; score: number }>>(
        apiKey, "knowledge/search", { query, ...(limit ? { limit } : {}) },
      );
      if (!hits.length) return text("No matching concepts. Use focus_learn to capture one.");
      return text(hits.map((h) => `knowledge:${h.slug} (${h.score.toFixed(2)}) — ${h.title}`).join("\n"));
    },
  );
  server.tool(
    "focus_learn",
    "Record a knowledge concept (cite-or-create; dedups by slug + meaning). Returns the slug to cite in a decision's refs.",
    { title: z.string(), body: z.string(), tags: z.array(z.string()).optional(), project: z.string().optional() },
    async ({ title, body, tags, project }) => {
      const r = await agentPost<{ slug: string; created: boolean; reason?: string }>(
        apiKey, "knowledge/upsert", { title, body, ...(tags ? { tags } : {}), ...(project ? { project } : {}) },
      );
      return text(`${r.created ? "created" : "reused (" + r.reason + ")"} → knowledge:${r.slug}`);
    },
  );
  return server;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization, x-focus-user, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const rawUser = req.headers["x-focus-user"] ?? req.query?.user;
  const userId = typeof rawUser === "string" ? rawUser : "";
  const auth = req.headers["authorization"];
  const apiKey = typeof auth === "string" ? auth.replace(/^Bearer\s+/i, "").trim() : "";
  if (!userId && !apiKey) {
    res.status(401).json({
      error: "Set x-focus-user (account id) for timer tools, or Authorization: Bearer ak_… for agent tools.",
    });
    return;
  }
  const server = buildServer(userId, apiKey);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
