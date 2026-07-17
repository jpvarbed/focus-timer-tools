import { describe, expect, test } from "bun:test";
import { cleanTranscript, extract } from "../scripts/distill";

describe("deterministic transcript candidates", () => {
  test("preserves user and assistant authorship through cleaning and extraction", () => {
    const transcript = [
      JSON.stringify({ type: "user", message: { content: "We should use Focus instead of a second memory database." } }),
      JSON.stringify({ type: "assistant", message: { content: "I will adopt a collector and deterministic ETL." } }),
    ].join("\n");
    expect(extract(cleanTranscript(transcript))).toEqual([
      expect.objectContaining({ who: "human", evidence: expect.stringContaining("use Focus") }),
      expect.objectContaining({ who: "agent", evidence: expect.stringContaining("adopt a collector") }),
    ]);
  });
});
