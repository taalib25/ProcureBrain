import type { DatasetGold } from "./dataset";
import type { SupplierCommitment } from "./schema";

export type Prediction = SupplierCommitment | null | {
  readonly expected?: SupplierCommitment | null;
  readonly commitment?: SupplierCommitment | null;
  readonly reviewState?: string;
  readonly state?: string;
};
export interface FieldMetric { readonly correct: number; readonly total: number; readonly accuracy: number }
export interface SplitEvaluation {
  readonly split: string;
  readonly examples: number;
  readonly missingPredictionCount: number;
  readonly reviewRate: number;
  readonly reviewCount: number;
  readonly reviewTotal: number;
  readonly goldReviewTotal: number;
  readonly correctlyReviewed: number;
  readonly reviewRecall: number;
  readonly unsafeAcceptCount: number;
  readonly unsafeAcceptRate: number;
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
    for (const row of rows) {
      const raw = predictions[row.id];
      const pred = normalize(raw);
      const missing = raw === undefined;
      const isReview = needsReview(raw, pred);
      const goldNeedsReview = row.expected === null || row.reviewState !== undefined || (row.expected?.confidence ?? 1) < 0.7;
      if (isReview) reviewCount++;
      if (missing) missingPredictionCount++;
      if (goldNeedsReview) {
        reviewTotal++;
        if (!missing && isReview) correctlyReviewed++;
        if (!missing && !isReview) unsafeAcceptCount++;
      }

      if (row.expected === null) {
        if (!missing && isReview) exactMatchCount++;
        continue;
      }
      let rowMatches = pred !== null;
      for (const field of scoreFields) {
        counts[field].total++;
        const matches = pred !== null && pred[field] === row.expected[field];
        if (matches) counts[field].correct++;
        else rowMatches = false;
      }
      const reviewDecisionMatches = isReview === goldNeedsReview;
      if (rowMatches && reviewDecisionMatches) exactMatchCount++;
    }
    return {
      split, examples: rows.length, reviewRate: rows.length ? reviewCount / rows.length : 0,
      reviewCount, reviewTotal: rows.length, goldReviewTotal: reviewTotal, missingPredictionCount, correctlyReviewed,
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

function normalize(value: Prediction | undefined): SupplierCommitment | null {
  if (value === undefined || value === null) return null;
  if ("poReference" in value) return value as SupplierCommitment;
  if ("expected" in value) return value.expected ?? null;
  return value.commitment ?? null;
}

function needsReview(value: Prediction | undefined, commitment: SupplierCommitment | null): boolean {
  if (value === undefined || value === null || commitment === null) return true;
  if ("poReference" in value) return value.confidence < 0.7;
  const state = value.reviewState ?? value.state;
  return state === undefined ? commitment.confidence < 0.7 : state !== "VALID";
}
