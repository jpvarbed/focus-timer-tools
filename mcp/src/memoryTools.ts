import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import { MAX_DECISION_SEARCH_RESULTS } from "../../memory/policy";

const FOCUS_SITE = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";

export function registerMemoryTools(server: McpServer, getKey: () => string): void {
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

  server.tool(
    "focus_collect",
    "Collect an explicitly confirmed file decision or Factory run receipt into the local append-only spool. This does not load Focus; run focus_sync_memory next.",
    {
      collector: z.enum(["file-decision", "factory-run"]),
      confirmed: z.literal(true).describe("literal true; durable capture is never ambient"),
      file: z.string().optional(),
      lineStart: z.number().int().positive().optional(),
      lineEnd: z.number().int().positive().optional(),
      action: z.enum(["create", "correct", "tombstone"]).optional(),
      text: z.string().optional(),
      priorEnvelopeId: z.string().optional().describe("local receipt whose Focus IDs authorize correction/retirement"),
      assertionId: z.string().optional(),
      expectedActiveRevisionId: z.string().optional(),
      receiptPath: z.string().optional().describe("Factory result receipt JSON path"),
      actor: z.string().optional(),
      project: z.string().optional(),
      cwd: z.string().optional(),
    },
    async (input) => {
      if (input.collector === "factory-run") {
        if (!input.receiptPath) throw new Error("factory-run collection requires receiptPath");
        const envelope = await collectFactoryRun({
          receiptPath: input.receiptPath,
          actor: input.actor ?? "factory-droid",
          ...(input.project ? { project: input.project } : {}),
          confirmed: true,
        });
        return text(JSON.stringify(envelope, null, 2));
      }
      if (!input.file || input.lineStart === undefined || input.lineEnd === undefined) {
        throw new Error("file-decision collection requires file, lineStart, and lineEnd");
      }
      const action = input.action ?? "create";
      const target = resolveDecisionTarget({
        action,
        ...(input.priorEnvelopeId ? { priorEnvelopeId: input.priorEnvelopeId } : {}),
        ...(input.assertionId ? { assertionId: input.assertionId } : {}),
        ...(input.expectedActiveRevisionId
          ? { expectedActiveRevisionId: input.expectedActiveRevisionId }
          : {}),
      });
      const envelope = await collectFileDecision({
        cwd: input.cwd ?? process.cwd(),
        file: input.file,
        lineStart: input.lineStart,
        lineEnd: input.lineEnd,
        ...target,
        ...(input.text ? { text: input.text } : {}),
        actor: input.actor ?? "mcp",
        ...(input.project ? { project: input.project } : {}),
        confirmed: true,
      });
      return text(JSON.stringify(envelope, null, 2));
    },
  );

  server.tool(
    "focus_sync_memory",
    "Validate and deterministically load every pending envelope into Focus. First sync requires explicit owner binding.",
    { bindOwner: z.boolean().optional().describe("explicitly bind an unassigned spool to this API key's owner") },
    async ({ bindOwner }) =>
      text(JSON.stringify(await syncPending({
        loader: new FocusHttpClient(FOCUS_SITE, getKey()),
        bindOwner: bindOwner === true,
      }), null, 2)),
  );

  server.tool(
    "focus_search_decisions",
    "Full-text recall of active decisions, restricted to the current repository and branch, with exact source citations.",
    { query: z.string().min(1), limit: z.number().int().positive().max(MAX_DECISION_SEARCH_RESULTS).optional(), cwd: z.string().optional() },
    async ({ query, limit, cwd }) => {
      const hits = await new FocusHttpClient(FOCUS_SITE, getKey()).searchDecisions({
        ...deriveRepositoryScope(cwd ?? process.cwd()),
        queryText: query,
        ...(limit ? { limit } : {}),
      });
      return text(JSON.stringify(hits, null, 2));
    },
  );

  server.tool(
    "focus_collector_status",
    "Count pending, loaded, quarantined, and failed-attempt memory envelopes.",
    {},
    async () => text(JSON.stringify(collectorStatus(), null, 2)),
  );

  server.tool(
    "focus_ingest_receipt",
    "Return the local or server verification receipt for a memory envelope.",
    { envelopeId: z.string().min(1) },
    async ({ envelopeId }) => {
      const receipt =
        readLocalReceipt(undefined, envelopeId) ??
        (await new FocusHttpClient(FOCUS_SITE, getKey()).receipt(envelopeId));
      if (!receipt) throw new Error("receipt not found: " + envelopeId);
      return text(JSON.stringify(receipt, null, 2));
    },
  );
}
