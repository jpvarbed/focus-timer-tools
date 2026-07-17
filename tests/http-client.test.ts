import { describe, expect, test } from "bun:test";
import { FocusHttpClient, FocusHttpError } from "../memory/pipeline";
import { MAX_TRANSPORT_BYTES } from "../memory/policy";

const jsonResponse = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Focus HTTP client boundary", () => {
  test("accepts only a credential-free HTTPS origin, except loopback HTTP", () => {
    expect(() => new FocusHttpClient("http://focus.example.com", "key")).toThrow(/HTTPS origin/i);
    expect(() => new FocusHttpClient("https://user:secret@focus.example.com", "key")).toThrow(/HTTPS origin/i);
    expect(() => new FocusHttpClient("https://focus.example.com/path", "key")).toThrow(/HTTPS origin/i);
    expect(() => new FocusHttpClient("http://127.0.0.1:3210", "key")).not.toThrow();
  });

  test("rejects search results outside the requested repository and branch", async () => {
    const client = new FocusHttpClient(
      "https://focus.example.com",
      "key",
      (async () => jsonResponse([
        {
          assertionId: "a1",
          revisionId: "r1",
          text: "other owner scope",
          repository: "github.com/other/repo",
          branch: "main",
          source: {
            repoRelativePath: "DECISIONS.md",
            sha256: "a".repeat(64),
            sourceVersion: "b".repeat(40),
            lineStart: 1,
            lineEnd: 1,
          },
        },
      ])) as typeof fetch,
    );
    await expect(client.searchDecisions({
      repository: "github.com/jason/focus",
      branch: "main",
      queryText: "scope",
    })).rejects.toThrow(/outside the requested scope/i);
  });

  test("rejects a decision search cardinality that could exceed the 1 MiB response boundary", async () => {
    const client = new FocusHttpClient(
      "https://focus.example.com",
      "key",
      (async () => { throw new Error("invalid input must not reach fetch"); }) as typeof fetch,
    );
    await expect(client.searchDecisions({
      repository: "github.com/jason/focus",
      branch: "main",
      queryText: "large decision",
      limit: 6,
    })).rejects.toThrow();
  });

  test("preserves HTTP status for retry classification and requires JSON", async () => {
    const unavailable = new FocusHttpClient(
      "https://focus.example.com",
      "key",
      (async () => jsonResponse({ error: "busy" }, 503)) as typeof fetch,
    );
    await expect(unavailable.receipt(`env_${"a".repeat(64)}`)).rejects.toBeInstanceOf(FocusHttpError);

    const html = new FocusHttpClient(
      "https://focus.example.com",
      "key",
      (async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })) as typeof fetch,
    );
    await expect(html.receipt(`env_${"a".repeat(64)}`)).rejects.toThrow(/not JSON/i);
  });

  test("knowledge export uses the shared redirect-safe bounded request boundary", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const client = new FocusHttpClient(
      "https://focus.example.com",
      "secret-key",
      (async (url, init) => {
        request = { url: String(url), init: init ?? {} };
        return jsonResponse([{ slug: "focus", title: "Focus", body: "memory" }]);
      }) as typeof fetch,
    );
    await expect(client.listKnowledge()).resolves.toEqual([
      expect.objectContaining({ slug: "focus", title: "Focus", body: "memory" }),
    ]);
    expect(request?.url).toBe("https://focus.example.com/agent/knowledge/list");
    expect(request?.init.redirect).toBe("error");
    expect(request?.init.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer secret-key");

    const oversized = new FocusHttpClient(
      "https://focus.example.com",
      "secret-key",
      (async () => new Response("[]", {
        headers: { "content-type": "application/json", "content-length": String(MAX_TRANSPORT_BYTES + 1) },
      })) as typeof fetch,
    );
    await expect(oversized.listKnowledge()).rejects.toThrow(/exceeds 1 MiB/i);
  });
});
