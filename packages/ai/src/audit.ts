import type { DatasetGold, DatasetMessage } from "./dataset";
import { goldRequiresReview } from "./evaluate";
import { SupplierCommitmentSchema } from "./schema";

export interface DatasetIssue { severity: "error" | "warning"; code: string; message: string; id?: string }
export interface DatasetAudit {
  messages: number;
  labels: number;
  patterns: number;
  structuralChecksPassed: boolean;
  splits: Array<{ split: string; messages: number; patterns: number; reviewRequired: number; confidenceDerivedReviewLabels: number }>;
  issues: DatasetIssue[];
}

/** Checks benchmark structure and exposes known label weaknesses without rewriting the holdout. */
export function auditDataset(messages: readonly DatasetMessage[], gold: readonly DatasetGold[]): DatasetAudit {
  const issues: DatasetIssue[] = [];
  const messageIds = new Set<string>();
  const goldById = new Map<string, DatasetGold>();
  const familySplits = new Map<string, Set<string>>();
  for (const row of gold) {
    if (goldById.has(row.id)) issues.push({ severity: "error", code: "duplicate_label", id: row.id, message: "More than one expected answer has this ID." });
    goldById.set(row.id, row);
  }
  for (const message of messages) {
    if (messageIds.has(message.id)) issues.push({ severity: "error", code: "duplicate_message", id: message.id, message: "More than one message has this ID." });
    messageIds.add(message.id);
    const seen = familySplits.get(message.templateFamily) ?? new Set<string>();
    seen.add(message.split); familySplits.set(message.templateFamily, seen);
    const row = goldById.get(message.id);
    if (!row) { issues.push({ severity: "error", code: "missing_label", id: message.id, message: "No expected answer exists for this message." }); continue; }
    if (row.split !== message.split || row.templateFamily !== message.templateFamily) issues.push({ severity: "error", code: "mismatched_assignment", id: row.id, message: "Message and expected answer have different split or pattern assignments." });
    if (row.expected === null && row.reviewRequired === false) issues.push({ severity: "error", code: "contradictory_review_label", id: row.id, message: "A null expected extraction cannot be labeled as accepted." });
    if (row.expected !== null) {
      if (!SupplierCommitmentSchema.safeParse(row.expected).success) {
        issues.push({ severity: "error", code: "invalid_expected_answer", id: row.id, message: "Expected extraction violates the schema or contains an impossible date." });
        continue;
      }
      if (!row.expected.evidence.every(quote => message.message.includes(quote))) issues.push({ severity: "error", code: "unsupported_gold_evidence", id: row.id, message: "Expected evidence is not quoted from the message." });
      if (row.reviewRequired === undefined && row.reviewState === undefined && row.expected.confidence < 0.7) issues.push({ severity: "warning", code: "confidence_derived_review", id: row.id, message: "Review expectation is encoded as a confidence score; use an explicit reviewed decision in the next benchmark." });
      if (row.templateFamily === "date-relative-only" && row.expected.type === "quantity_change") issues.push({ severity: "warning", code: "type_taxonomy_mismatch", id: row.id, message: "The message does not compare quantities with a previous quantity; its quantity_change label needs review." });
      if (row.templateFamily === "quantity-unspecified" && row.expected.type === "eta_change") issues.push({ severity: "warning", code: "type_taxonomy_mismatch", id: row.id, message: "The message states an arrival date without a previous ETA comparison; its eta_change label needs review." });
    }
  }
  for (const row of gold) if (!messageIds.has(row.id)) issues.push({ severity: "error", code: "orphan_label", id: row.id, message: "Expected answer has no matching message." });
  for (const [family, splits] of familySplits) if (splits.size > 1) issues.push({ severity: "error", code: "family_leakage", message: `Pattern ${family} appears in more than one split.` });
  const splits = [...new Set(messages.map(row => row.split))].map(split => {
    const selected = messages.filter(row => row.split === split);
    const labels = selected.flatMap(row => goldById.has(row.id) ? [goldById.get(row.id)!] : []);
    return { split, messages: selected.length, patterns: new Set(selected.map(row => row.templateFamily)).size,
      reviewRequired: labels.filter(goldRequiresReview).length,
      confidenceDerivedReviewLabels: labels.filter(row => row.expected != null && row.reviewRequired === undefined && row.reviewState === undefined && row.expected.confidence < 0.7).length };
  });
  for (const split of splits) if (!split.reviewRequired) issues.push({ severity: "warning", code: "no_review_cases", message: `${split.split} contains no expected review cases, so it cannot measure missed ambiguity.` });
  return { messages: messages.length, labels: gold.length, patterns: familySplits.size, structuralChecksPassed: !issues.some(issue => issue.severity === "error"), splits, issues };
}
