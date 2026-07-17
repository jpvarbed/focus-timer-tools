import type { DecisionAction } from "./contracts";
import { readLocalReceipt } from "./spool";

export type DecisionTarget =
  | { action: "create" }
  | { action: "correct"; assertionId: string; expectedActiveRevisionId: string }
  | { action: "tombstone"; assertionId: string; expectedActiveRevisionId: string };

export function resolveDecisionTarget(input: {
  action: DecisionAction;
  spoolRoot?: string;
  priorEnvelopeId?: string;
  assertionId?: string;
  expectedActiveRevisionId?: string;
}): DecisionTarget {
  if (input.action === "create") return { action: "create" };
  let assertionId = input.assertionId;
  let expectedActiveRevisionId = input.expectedActiveRevisionId;
  if (input.priorEnvelopeId) {
    const result = readLocalReceipt(input.spoolRoot, input.priorEnvelopeId)?.results[0];
    if (!result) throw new Error(`receipt not found or empty: ${input.priorEnvelopeId}`);
    if (result.op === "knowledge.upsert" || result.op === "provenance.append") {
      throw new Error(`receipt does not contain a decision result: ${input.priorEnvelopeId}`);
    }
    assertionId = typeof result.assertionId === "string" ? result.assertionId : undefined;
    expectedActiveRevisionId =
      typeof result.currentActiveRevisionId === "string"
        ? result.currentActiveRevisionId
        : typeof result.revisionId === "string"
          ? result.revisionId
          : undefined;
  }
  if (!assertionId || !expectedActiveRevisionId) {
    throw new Error("correction/retirement requires assertionId and expectedActiveRevisionId from a receipt");
  }
  return { action: input.action, assertionId, expectedActiveRevisionId };
}
