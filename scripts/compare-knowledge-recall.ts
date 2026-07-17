#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import path from "node:path";
import { FocusHttpClient, type KnowledgeExportRow } from "../memory/client";

type Expectation = { query: string; expectedSlugs: string[] };

function words(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matches(text: string, query: string): boolean {
  const haystack = words(text);
  return words(query).every((term) => haystack.some((word) => word.startsWith(term)));
}

/** Deterministic approximation used before deployment, when the new full-text endpoint is not live:
 * title hits first, body-only hits second, exact slug dedupe. It never calls the legacy search path. */
export function localFullText(rows: KnowledgeExportRow[], query: string): string[] {
  const title = rows.filter((row) => matches(row.title, query));
  const titleIds = new Set(title.map((row) => row.slug));
  const body = rows.filter((row) => !titleIds.has(row.slug) && matches(row.body, query));
  return [...title, ...body].map((row) => row.slug);
}

async function main() {
  const key = process.env.FOCUS_API_KEY;
  if (!key) throw new Error("FOCUS_API_KEY is required for the read-only knowledge export");
  const site = process.env.FOCUS_CONVEX_SITE ?? "https://perceptive-butterfly-406.convex.site";
  const expectationsPath =
    process.argv[2] ?? path.join(import.meta.dir, "..", "docs", "knowledge-recall-expectations.json");
  const expectations = JSON.parse(readFileSync(expectationsPath, "utf8")) as Expectation[];
  const rows = await new FocusHttpClient(site, key).listKnowledge();

  let missed = 0;
  const comparisons = expectations.map((expectation) => {
    const matchedSlugs = localFullText(rows, expectation.query);
    const missedSlugs = expectation.expectedSlugs.filter((slug) => !matchedSlugs.includes(slug));
    missed += missedSlugs.length;
    return {
      query: expectation.query,
      expectedCount: expectation.expectedSlugs.length,
      matchedCount: expectation.expectedSlugs.length - missedSlugs.length,
      matchedSlugs: expectation.expectedSlugs.filter((slug) => matchedSlugs.includes(slug)),
      missedSlugs,
    };
  });
  console.log(JSON.stringify({ rowCount: rows.length, queryCount: expectations.length, missed, comparisons }, null, 2));
  if (missed > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
