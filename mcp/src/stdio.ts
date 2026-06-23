#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

// Agent-write tools (report/ask/event/recall/learn) use FOCUS_API_KEY; timer control/read tools
// use FOCUS_USER_ID against the timer deployment until auth ships to prod. Either may be set.
const userId = process.env.FOCUS_USER_ID ?? "";
const apiKey = process.env.FOCUS_API_KEY ?? "";
if (!userId && !apiKey) {
  console.error(
    "Set FOCUS_API_KEY (focus web → Settings → Mint key) for agent tools, and/or FOCUS_USER_ID\n" +
      "(web cookie 'focus_user_id') for timer control/read tools.",
  );
  process.exit(1);
}

const server = buildServer({
  convexUrl: process.env.CONVEX_URL,
  getUserId: () => userId,
  getKey: () => apiKey,
});
await server.connect(new StdioServerTransport());
