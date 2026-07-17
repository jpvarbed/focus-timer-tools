import { z } from "zod";
import {
  DecisionSearchHitSchema,
  LoadBatchSchema,
  LoadReceiptSchema,
  StoredReceiptSchema,
  requireEnvelopeId,
  type DecisionSearchHit,
  type FocusLoader,
  type LoadBatch,
  type ServerReceipt,
  type StoredReceipt,
} from "./contracts";
import { MAX_DECISION_SEARCH_RESULTS, MAX_TRANSPORT_BYTES } from "./policy";

const SearchInputSchema = z.object({
  repository: z.string().min(1),
  branch: z.string().min(1),
  queryText: z.string().trim().min(1),
  limit: z.number().int().min(1).max(MAX_DECISION_SEARCH_RESULTS).optional(),
}).strict();
const WatermarkSchema = z.object({ ownerKey: z.string().regex(/^[0-9a-f]{64}$/) }).passthrough();
const KnowledgeExportRowSchema = z.object({
  slug: z.string().min(1),
  title: z.string(),
  body: z.string(),
}).passthrough();
export type KnowledgeExportRow = z.infer<typeof KnowledgeExportRowSchema>;

export class FocusHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FocusHttpError";
  }
}

export class FocusHttpClient implements FocusLoader {
  private readonly site: string;

  constructor(
    site: string,
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(site);
    const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
    if (
      (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "/" && url.pathname !== "")
    ) {
      throw new Error("Focus site must be an HTTPS origin (HTTP is allowed only for loopback)");
    }
    this.site = url.origin;
  }

  private async request(pathName: string, init?: RequestInit): Promise<unknown> {
    if (!this.key) throw new Error("FOCUS_API_KEY is required");
    const response = await this.fetchImpl(`${this.site}/agent/${pathName}`, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      redirect: "error",
      headers: {
        Authorization: `Bearer ${this.key}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_TRANSPORT_BYTES) throw new Error("Focus response exceeds 1 MiB");
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_TRANSPORT_BYTES) throw new Error("Focus response exceeds 1 MiB");
    if (!response.ok) throw new FocusHttpError(response.status, `Focus request failed (${response.status}): ${text.slice(0, 512)}`);
    if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      throw new Error("Focus response is not JSON");
    }
    return JSON.parse(text) as unknown;
  }

  async load(batch: LoadBatch): Promise<ServerReceipt> {
    const validated = LoadBatchSchema.parse(batch);
    return LoadReceiptSchema.parse(
      await this.request("ingest/batch", { method: "POST", body: JSON.stringify(validated) }),
    );
  }

  async ownerKey(): Promise<string> {
    return WatermarkSchema.parse(await this.request("memory/watermark")).ownerKey;
  }

  async listKnowledge(): Promise<KnowledgeExportRow[]> {
    return z.array(KnowledgeExportRowSchema).parse(await this.request("knowledge/list"));
  }

  async searchDecisions(input: {
    repository: string;
    branch: string;
    queryText: string;
    limit?: number;
  }): Promise<DecisionSearchHit[]> {
    const validated = SearchInputSchema.parse(input);
    const hits = z.array(DecisionSearchHitSchema).parse(
      await this.request("memory/search", {
        method: "POST",
        body: JSON.stringify(validated),
      }),
    );
    if (hits.some((hit) => hit.repository !== validated.repository || hit.branch !== validated.branch)) {
      throw new Error("Focus search returned a result outside the requested scope");
    }
    return hits;
  }

  async receipt(envelopeId: string): Promise<StoredReceipt | null> {
    requireEnvelopeId(envelopeId);
    const receipt = StoredReceiptSchema.nullable().parse(
      await this.request(`ingest/receipt?envelopeId=${encodeURIComponent(envelopeId)}`),
    );
    if (receipt !== null && receipt.envelopeId !== envelopeId) throw new Error("Focus receipt envelopeId mismatch");
    return receipt;
  }
}
