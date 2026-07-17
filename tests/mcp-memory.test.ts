import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const clients: Client[] = [];
const transports: StdioClientTransport[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
});

async function connect() {
  const spool = mkdtempSync(path.join(os.tmpdir(), "focus-mcp-spool-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(import.meta.dir, "..", "mcp", "src", "stdio.ts")],
    cwd: path.join(import.meta.dir, ".."),
    stderr: "pipe",
    env: {
      ...process.env,
      FOCUS_API_KEY: "test-key-not-used-by-status",
      FOCUS_USER_ID: "test-user",
      FOCUS_MEMORY_SPOOL: spool,
    } as Record<string, string>,
  });
  const client = new Client({ name: "focus-memory-test", version: "1.0.0" });
  transports.push(transport);
  clients.push(client);
  await client.connect(transport);
  return client;
}

describe("local MCP decision-memory surface", () => {
  test("official client discovers all five memory tools with schemas", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "focus_collect",
        "focus_sync_memory",
        "focus_search_decisions",
        "focus_collector_status",
        "focus_ingest_receipt",
      ]),
    );
    for (const name of [
      "focus_collect",
      "focus_sync_memory",
      "focus_search_decisions",
      "focus_collector_status",
      "focus_ingest_receipt",
    ]) {
      expect(tools.find((tool) => tool.name === name)?.inputSchema).toBeDefined();
    }
  });

  test("collector status returns a protocol result and invalid collection returns an error result", async () => {
    const client = await connect();
    const status = await client.callTool({ name: "focus_collector_status", arguments: {} });
    expect(status.isError).not.toBe(true);
    const statusText = (status.content[0] as { type: "text"; text: string }).text;
    expect(JSON.parse(statusText)).toEqual({ pending: 0, unknown: 0, receipts: 0, quarantined: 0, attempts: 0 });

    const invalid = await client.callTool({
      name: "focus_collect",
      arguments: { collector: "file-decision", confirmed: true },
    });
    expect(invalid.isError).toBe(true);

    const traversal = await client.callTool({
      name: "focus_ingest_receipt",
      arguments: { envelopeId: "../../secret" },
    });
    expect(traversal.isError).toBe(true);
  });
});
