import type { DatasetGold } from "./dataset";
import { SupplierCommitmentSchema, reviewStates, type SupplierCommitment } from "./schema";

export type Prediction = SupplierCommitment | null | {
  readonly commitment?: SupplierCommitment | null;
  readonly reviewState?: string;
  readonly state?: string;
  readonly failure?: string;
};
export interface FieldMetric { readonly correct: number; readonly total: number; readonly accuracy: number }
export interface SplitEvaluation {
  readonly split: string;
  readonly examples: number;
  readonly missingPredictionCount: number;
  readonly invalidPredictionCount: number;
  readonly executionFailureCount: number;
  readonly reviewRate: number;
  readonly reviewCount: number;
  readonly reviewTotal: number;
  readonly goldReviewTotal: number;
  readonly correctlyReviewed: number;
  readonly reviewRecall: number;
  readonly unsafeAcceptCount: number;
  readonly unsafeAcceptRate: number;
  readonly falseReviewCount: number;
  readonly falseReviewRate: number;
  readonly exactMatch: FieldMetric;
  readonly fields: Readonly<Record<"poReference" | "eta" | "quantity" | "type", FieldMetric>>;
}

/** Missing predictions are treated as unknown (null fields + needs review), never as a correct answer. */
export function evaluateBySplit(gold: readonly DatasetGold[], predictions: Readonly<Record<string, Prediction>>): SplitEvaluation[] {
  const splits = [...new Set(gold.map(row => row.split))];
  return splits.map(split => {
    const rows = gold.filter(row => row.split === split);
    const scoreFields = ["poReference", "eta", "quantity", "type"] as const;
    const counts = Object.fromEntries(scoreFields.map(field => [field, { correct: 0, total: 0 }])) as Record<typeof scoreFields[number], { correct: number; total: number }>;
    let reviewCount = 0;
    let reviewTotal = 0;
    let correctlyReviewed = 0;
    let unsafeAcceptCount = 0;
    let exactMatchCount = 0;
    let missingPredictionCount = 0;
    let invalidPredictionCount = 0;
    let executionFailureCount = 0;
    let falseReviewCount = 0;
    for (const row of rows) {
      const raw = predictions[row.id];
      const prediction = readPrediction(raw);
      const pred = prediction.commitment;
      const missing = raw === undefined;
      const isReview = prediction.review;
      const goldNeedsReview = goldRequiresReview(row);
      if (isReview) reviewCount++;
      if (missing) missingPredictionCount++;
      if (prediction.failure) executionFailureCount++;
      else if (!missing && !prediction.valid) invalidPredictionCount++;
      if (goldNeedsReview) {
        reviewTotal++;
        if (prediction.valid && isReview) correctlyReviewed++;
        if (prediction.valid && !isReview) unsafeAcceptCount++;
      } else if (prediction.valid && isReview) falseReviewCount++;

      if (row.expected === null) {
        if (prediction.valid && isReview) exactMatchCount++;
        continue;
      }
      let rowMatches = prediction.valid && pred !== null;
      for (const field of scoreFields) {
        counts[field].total++;
        const matches = prediction.valid && pred !== null && pred[field] === row.expected[field];
        if (matches) counts[field].correct++;
        else rowMatches = false;
      }
      const reviewDecisionMatches = isReview === goldNeedsReview;
      if (rowMatches && reviewDecisionMatches) exactMatchCount++;
    }
    return {
      split, examples: rows.length, reviewRate: rows.length ? reviewCount / rows.length : 0,
      reviewCount, reviewTotal: rows.length, goldReviewTotal: reviewTotal, missingPredictionCount, correctlyReviewed,
      invalidPredictionCount, executionFailureCount, falseReviewCount,
      falseReviewRate: rows.length > reviewTotal ? falseReviewCount / (rows.length - reviewTotal) : 0,
      reviewRecall: reviewTotal ? correctlyReviewed / reviewTotal : 0,
      unsafeAcceptCount,
      unsafeAcceptRate: reviewTotal ? unsafeAcceptCount / reviewTotal : 0,
      exactMatch: { correct: exactMatchCount, total: rows.length, accuracy: rows.length ? exactMatchCount / rows.length : 0 },
      fields: Object.fromEntries(scoreFields.map(field => [field, {
        correct: counts[field].correct, total: counts[field].total,
        accuracy: counts[field].total ? counts[field].correct / counts[field].total : 0,
      }])) as SplitEvaluation["fields"],
    };
  });
}

export function goldRequiresReview(row: DatasetGold): boolean {
  // Legacy confidence-derived labels remain supported to reproduce the frozen v1 report.
  // New benchmarks should make the expected review decision explicit.
  return row.expected === null || row.reviewState !== undefined || (row.reviewRequired ?? ((row.expected?.confidence ?? 1) < 0.7));
}

function readPrediction(value: Prediction | undefined): { commitment: SupplierCommitment | null; review: boolean; valid: boolean; failure: boolean } {
  const invalid = { commitment: null, review: true, valid: false, failure: false };
  if (value === undefined) return invalid;
  if (value === null) return { ...invalid, valid: true };
  if (typeof value !== "object" || Array.isArray(value)) return invalid;
  if (!("poReference" in value) && value.failure) return { ...invalid, failure: true };
  const direct = "poReference" in value;
  if (!direct && (Object.keys(value).some(key => !["commitment", "state", "reviewState", "failure"].includes(key)) || !("commitment" in value))) return invalid;
  const state = direct ? undefined : value.reviewState ?? value.state;
  if (state !== undefined && !reviewStates.includes(state as typeof reviewStates[number])) return invalid;
  const raw = direct ? value : value.commitment;
  if (raw === null) return state === "VALID" ? invalid : { ...invalid, valid: true };
  const parsed = SupplierCommitmentSchema.safeParse(raw);
  if (!parsed.success) return invalid;
  return { commitment: parsed.data, review: state === undefined ? parsed.data.confidence < 0.7 : state !== "VALID", valid: true, failure: false };
}
