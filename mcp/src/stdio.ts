#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "./server.js";

const userId = process.env.FOCUS_USER_ID;
if (!userId) {
  console.error(
    "Set FOCUS_USER_ID — your focus.jasonv.dev account id (devtools → Application →\n" +
      "Cookies → focus_user_id), or any stable id to start a fresh timer.",
  );
  process.exit(1);
}

const server = buildServer({ convexUrl: process.env.CONVEX_URL, getUserId: () => userId });
await server.connect(new StdioServerTransport());
