import { describe, expect, it } from "vitest";
import { generateDataset } from "../src/dataset";
import { evaluateBySplit, type Prediction } from "../src/evaluate";

describe("synthetic extraction dataset", () => {
  it("reproduces 300 scenario-authored records with family-isolated splits and gold truth", () => {
    const first = generateDataset();
    const second = generateDataset();
    expect(first).toEqual(second);
    expect(first.messages).toHaveLength(300);
    expect(first.gold).toHaveLength(300);
    expect(new Set(first.messages.map(row => row.id)).size).toBe(300);
    expect(first.messages.map(row => row.id)).toEqual(first.gold.map(row => row.id));
    const familySplits = new Map<string, Set<string>>();
    for (const row of first.messages) {
      const seen = familySplits.get(row.templateFamily) ?? new Set<string>();
      seen.add(row.split);
      familySplits.set(row.templateFamily, seen);
    }
    expect([...familySplits.values()].every(splits => splits.size === 1)).toBe(true);
    expect(first.messages.filter(row => row.split === "development")).toHaveLength(180);
    expect(first.messages.filter(row => row.split === "validation")).toHaveLength(60);
    expect(first.messages.filter(row => row.split === "holdout")).toHaveLength(60);
    for (const row of first.gold) {
      if (row.expected !== null) {
        expect(row.expected.evidence[0]).toBe(first.messages.find(message => message.id === row.id)!.message);
        expect(row.reviewState).toBeUndefined();
      } else expect(row.reviewState).toBeTruthy();
    }
    expect(first.messages.some(row => /without (a )?PO reference|PO reference omitted/i.test(row.message))).toBe(true);
    expect(first.messages.some(row => /04\/05\/2027|5\/6/.test(row.message))).toBe(true);
    expect(first.messages.some(row => /Fwd|Forwarded|Fwd chain/.test(row.message))).toBe(true);
  });

  it("calculates exact field metrics and review rate independently for every split; absent answers are unknown", () => {
    const { gold } = generateDataset(1);
    const predictions: Record<string, null> = {};
    const metrics = evaluateBySplit(gold, predictions);
    expect(metrics.map(metric => metric.split)).toEqual(["development", "validation", "holdout"]);
    expect(metrics.map(metric => metric.examples)).toEqual([18, 6, 6]);
    expect(metrics.map(metric => metric.fields.eta.total)).toEqual([13, 6, 4]);
    for (const metric of metrics) {
      expect(metric.reviewRate).toBe(1);
      expect(metric.reviewCount).toBe(metric.reviewTotal);
      for (const field of Object.values(metric.fields)) expect(field).toEqual({ correct: 0, total: metric.fields.eta.total, accuracy: 0 });
    }

    const perfect: Record<string, Prediction> = {};
    for (const row of gold) perfect[row.id] = row.expected === null ? null : { ...row.expected };
    const perfectMetrics = evaluateBySplit(gold, perfect);
    for (const metric of perfectMetrics) {
      const expectedReviews = gold.filter(row => row.split === metric.split && (
        row.expected === null || row.reviewState !== undefined || row.expected.confidence < 0.7
      )).length;
      expect(metric.reviewRate).toBe(expectedReviews / metric.examples);
      for (const field of Object.values(metric.fields)) expect(field).toEqual({ correct: metric.fields.eta.total, total: metric.fields.eta.total, accuracy: 1 });
    }

    const changedOneField = { ...perfect };
    const known = gold.find(row => row.split === "development" && row.expected !== null)!;
    changedOneField[known.id] = { ...known.expected!, eta: null };
    const development = evaluateBySplit(gold, changedOneField)[0]!;
    expect(development.fields.eta).toEqual({ correct: 12, total: 13, accuracy: 12 / 13 });
    expect(development.fields.poReference).toEqual({ correct: 13, total: 13, accuracy: 1 });
  });
});
