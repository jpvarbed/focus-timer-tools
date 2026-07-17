import { describe, expect, test } from "bun:test";
import { localFullText } from "../scripts/compare-knowledge-recall";

describe("predeploy knowledge comparison", () => {
  test("ranks title matches before body-only matches and dedupes slugs", () => {
    const rows = [
      { slug: "body", title: "Transport", body: "Convex backend choice" },
      { slug: "title", title: "Convex backend", body: "Choice" },
    ];
    expect(localFullText(rows, "conv back")).toEqual(["title", "body"]);
  });
});
