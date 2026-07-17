import {
  canonicalJson,
  LoadBatchSchema,
  parseEnvelope,
  parseFactoryReceipt,
  sha256,
  type LoadBatch,
  type LoadOperation,
  type MemoryEnvelope,
} from "./contracts";
import { MAX_FACTORY_REASONING_CHARS } from "./policy";

async function validateEnvelope(envelope: MemoryEnvelope): Promise<void> {
  parseEnvelope(JSON.stringify(envelope));
  if (envelope.kind === "factory-run") {
    parseFactoryReceipt(envelope.raw);
  }
}

function sourceFields(envelope: Extract<MemoryEnvelope, { kind: "file-decision" }>) {
  return {
    repository: envelope.source.repository,
    branch: envelope.source.branch,
    sourceRepoRelativePath: envelope.source.repoRelativePath,
    sourceSha256: envelope.source.sha256,
    sourceVersion: envelope.source.sourceVersion,
    lineStart: envelope.source.lineStart,
    lineEnd: envelope.source.lineEnd,
    agent: envelope.actor,
    confirmed: true as const,
  };
}

function decisionOperation(envelope: Extract<MemoryEnvelope, { kind: "file-decision" }>): LoadOperation {
  const common = sourceFields(envelope);
  switch (envelope.raw.action) {
    case "create":
      return { ...common, op: "decision.create", text: envelope.raw.text };
    case "correct":
      return {
        ...common,
        op: "decision.correct",
        text: envelope.raw.text,
        assertionId: envelope.raw.assertionId,
        expectedActiveRevisionId: envelope.raw.expectedActiveRevisionId,
      };
    case "tombstone":
      return {
        ...common,
        op: "decision.tombstone",
        assertionId: envelope.raw.assertionId,
        expectedActiveRevisionId: envelope.raw.expectedActiveRevisionId,
      };
  }
}

function factoryReasoning(receipt: Extract<MemoryEnvelope, { kind: "factory-run" }>['raw']): string {
  const summary = {
    elapsedMs: receipt.elapsedMs,
    correctionPrompts: receipt.correctionPrompts,
    testCommandCount: receipt.tests.length,
    bugCount: receipt.bugs.length,
    tests: [] as typeof receipt.tests,
    bugs: [] as string[],
    // Start at the largest digit width. Including an item decrements its omitted count, so later
    // bookkeeping cannot unexpectedly push a previously fitting summary over the server limit.
    omittedTests: receipt.tests.length,
    omittedBugs: receipt.bugs.length,
    truncatedBugs: 0,
  };

  // Bug reports are the decision-useful part of a Factory receipt. Preserve the first one before
  // spending the budget on test commands, even when it must be represented by a bounded excerpt.
  const [firstBug, ...remainingBugs] = receipt.bugs;
  if (firstBug !== undefined) {
    const full = { ...summary, bugs: [firstBug], omittedBugs: summary.omittedBugs - 1 };
    if (JSON.stringify(full).length <= MAX_FACTORY_REASONING_CHARS) {
      Object.assign(summary, full);
    } else {
      const suffix = "… [truncated]";
      const withSuffix = {
        ...summary,
        bugs: [suffix],
        omittedBugs: summary.omittedBugs - 1,
        truncatedBugs: 1,
      };
      // A JSON string can expand one UTF-16 code unit to at most six characters (`\\uXXXX`).
      const prefixUnits = Math.max(
        1,
        Math.min(firstBug.length, Math.floor((MAX_FACTORY_REASONING_CHARS - JSON.stringify(withSuffix).length) / 6)),
      );
      Object.assign(withSuffix, { bugs: [`${firstBug.slice(0, prefixUnits)}${suffix}`] });
      Object.assign(summary, withSuffix);
    }
  }
  for (const bug of remainingBugs) {
    const candidate = { ...summary, bugs: [...summary.bugs, bug], omittedBugs: summary.omittedBugs - 1 };
    if (JSON.stringify(candidate).length <= MAX_FACTORY_REASONING_CHARS) Object.assign(summary, candidate);
  }
  for (const test of receipt.tests) {
    const candidate = { ...summary, tests: [...summary.tests, test], omittedTests: summary.omittedTests - 1 };
    if (JSON.stringify(candidate).length <= MAX_FACTORY_REASONING_CHARS) Object.assign(summary, candidate);
  }
  const reasoning = JSON.stringify(summary);
  if (reasoning.length > MAX_FACTORY_REASONING_CHARS) throw new Error("Factory summary exceeds loader reasoning limit");
  return reasoning;
}

export async function transformEnvelope(envelope: MemoryEnvelope): Promise<LoadBatch> {
  await validateEnvelope(envelope);
  let operations: LoadOperation[];
  if (envelope.kind === "file-decision") {
    operations = [decisionOperation(envelope)];
  } else {
    const receipt = envelope.raw;
    operations = [
      {
        op: "provenance.append",
        agent: envelope.actor,
        type: "output",
        summary: `Factory ${receipt.sessionId}: ${receipt.toolCalls} tool calls, ${receipt.tests.filter((test) => test.passed).length}/${receipt.tests.length} test commands passed`,
        reasoning: factoryReasoning(receipt),
        refs: [
          { type: "derived_from", target: `factory-session:${receipt.sessionId}` },
          { type: "derived_from", target: `envelope:${envelope.envelopeId}` },
        ],
        confirmed: true,
      },
    ];
  }
  const payload = {
    schemaVersion: 1 as const,
    collector: envelope.collector,
    envelopeId: envelope.envelopeId,
    operations,
  };
  return LoadBatchSchema.parse({
    ...payload,
    clientKey: `op_${sha256(canonicalJson(payload))}`,
  });
}
