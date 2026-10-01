import { describe, expect, it } from "vitest";
import { auditDataset } from "../src/audit";
import { generateDataset, type DatasetGold } from "../src/dataset";
import { evaluateBySplit, type Prediction } from "../src/evaluate";
import { SupplierCommitmentSchema } from "../src/schema";

describe("evaluation quality checks", () => {
  it("audits the frozen benchmark without changing its labels and makes review coverage visible", () => {
    const data = generateDataset();
    const before = structuredClone(data);
    const audit = auditDataset(data.messages, data.gold);
    expect(data).toEqual(before);
    expect(audit).toMatchObject({ messages: 300, labels: 300, patterns: 30, structuralChecksPassed: true });
    expect(audit.splits.find(split => split.split === "holdout")).toMatchObject({ messages: 60, patterns: 6, reviewRequired: 30, confidenceDerivedReviewLabels: 10 });
    expect(audit.issues.filter(issue => issue.code === "type_taxonomy_mismatch")).toHaveLength(20);
    expect(audit.issues.some(issue => issue.code === "no_review_cases" && issue.message.startsWith("validation"))).toBe(true);
  });

  it("detects leakage of a scenario family across splits and unmatched labels", () => {
    const data = generateDataset(2);
    const changed = data.messages.map((message, index) => index === 0 ? { ...message, split: "holdout" as const } : message);
    const audit = auditDataset(changed, data.gold.slice(1));
    expect(audit.structuralChecksPassed).toBe(false);
    expect(audit.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["family_leakage", "missing_label"]));
  });

  it("flags malformed expected answers instead of treating the label file as trustworthy", () => {
    const data = generateDataset(1);
    const gold = data.gold.map((row, index) => index === 0 ? { ...row, expected: { ...row.expected!, eta: "2026-02-30", evidence: [] } } : row);
    const audit = auditDataset(data.messages, gold);
    expect(audit.structuralChecksPassed).toBe(false);
    expect(audit.issues.some(issue => issue.code === "invalid_expected_answer")).toBe(true);
    const missingAnswer = data.gold.map((row, index) => index === 0 ? { ...row, expected: undefined } : row) as unknown as DatasetGold[];
    expect(auditDataset(data.messages, missingAnswer).issues.some(issue => issue.code === "invalid_expected_answer")).toBe(true);
  });

  it("does not reward provider failures, malformed predictions, or missing answers as review decisions", () => {
    const gold: DatasetGold[] = ["good", "failed", "invalid", "missing"].map(id => ({ id, expected: null, reviewState: "REQUIRES_REVIEW", templateFamily: "ambiguous", split: "development" }));
    const predictions = { good: null, failed: { commitment: null, state: "REQUIRES_REVIEW", failure: "provider_error" }, invalid: "bad JSON" } as unknown as Record<string, Prediction>;
    const result = evaluateBySplit(gold, predictions)[0]!;
    expect(result).toMatchObject({ correctlyReviewed: 1, executionFailureCount: 1, invalidPredictionCount: 1, missingPredictionCount: 1, reviewRecall: 0.25 });
    expect(result.exactMatch).toEqual({ correct: 1, total: 4, accuracy: 0.25 });
  });

  it("uses an explicit expected review decision independently of the benchmark confidence score", () => {
    const row = generateDataset(1).gold.find(row => row.expected !== null)!;
    const expected = { ...row.expected!, confidence: 0.99 };
    const result = evaluateBySplit([{ ...row, expected, reviewRequired: true }], { [row.id]: { commitment: expected, state: "VALID" } })[0]!;
    expect(result).toMatchObject({ goldReviewTotal: 1, unsafeAcceptCount: 1, unsafeAcceptRate: 1 });
    expect(result.exactMatch.correct).toBe(0);
    const accepted = evaluateBySplit([{ ...row, expected: { ...expected, confidence: 0.2 }, reviewRequired: false }], { [row.id]: { commitment: expected, state: "VALID" } })[0]!;
    expect(accepted.goldReviewTotal).toBe(0);
    expect(accepted.exactMatch.correct).toBe(1);
  });

  it("reports unnecessary review separately and rejects gold-answer envelopes as predictions", () => {
    const row = generateDataset(1).gold.find(row => row.expected !== null)!;
    const result = evaluateBySplit([row], { [row.id]: { commitment: row.expected, state: "LOW_CONFIDENCE" } })[0]!;
    expect(result).toMatchObject({ falseReviewCount: 1, falseReviewRate: 1, goldReviewTotal: 0 });
    const copiedGold = evaluateBySplit([row], { [row.id]: row as unknown as Prediction })[0]!;
    expect(copiedGold.invalidPredictionCount).toBe(1);
    expect(copiedGold.exactMatch.correct).toBe(0);
  });

  it("rejects impossible model dates at the extraction boundary while accepting a leap day", () => {
    const expected = generateDataset(1).gold.find(row => row.expected !== null)!.expected!;
    expect(SupplierCommitmentSchema.safeParse({ ...expected, eta: "2026-02-30" }).success).toBe(false);
    expect(SupplierCommitmentSchema.safeParse({ ...expected, eta: "2026-02-29" }).success).toBe(false);
    expect(SupplierCommitmentSchema.safeParse({ ...expected, eta: "2028-02-29" }).success).toBe(true);
  });
});
