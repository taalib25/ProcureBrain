import type { DatasetGold } from "./dataset";
import type { SupplierCommitment } from "./schema";

export type Prediction = SupplierCommitment | null | { readonly expected?: SupplierCommitment | null; readonly reviewState?: string };
export interface FieldMetric { readonly correct: number; readonly total: number; readonly accuracy: number }
export interface SplitEvaluation {
  readonly split: string;
  readonly examples: number;
  readonly reviewRate: number;
  readonly reviewCount: number;
  readonly reviewTotal: number;
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
    for (const row of rows) {
      const raw = predictions[row.id];
      const pred = normalize(raw);
      const isReview = raw === undefined || pred === null;
      if (isReview) reviewCount++;
      if (row.expected === null) continue;
      for (const field of scoreFields) {
        counts[field].total++;
        if (pred !== null && pred[field] === row.expected[field]) counts[field].correct++;
      }
    }
    return {
      split, examples: rows.length, reviewRate: rows.length ? reviewCount / rows.length : 0,
      reviewCount, reviewTotal: rows.length,
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
  return value.expected ?? null;
}
