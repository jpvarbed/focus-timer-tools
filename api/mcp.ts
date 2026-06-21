// Remote (HTTP) MCP endpoint for the focus timer — a stateless Streamable-HTTP transport,
// deployed as a Vercel function so it has a callable URL (for ARD discovery).
// The caller's focus account id comes from the `x-focus-user` header.
//
// Self-contained on purpose (no cross-workspace import) so the serverless bundle is simple.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const DEFAULT_CONVEX_URL = "https://perceptive-butterfly-406.convex.cloud";
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

function buildServer(userId: string) {
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
  return server;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-focus-user, mcp-session-id, mcp-protocol-version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  const userId = req.headers["x-focus-user"] ?? req.query?.user;
  if (!userId || typeof userId !== "string") {
    res.status(401).json({ error: "Set the x-focus-user header to your focus.jasonv.dev account id." });
    return;
  }
  const server = buildServer(userId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
