import { describe, expect, it } from "vitest";
import { realisticDataset, realisticMessagesById } from "../src/realistic-dataset";
import { evaluateBySplit, evidenceSupport, goldRequiresReview, type Prediction } from "../src/evaluate";

describe("realistic evaluation set", () => {
  it("holds dataset invariants: verbatim evidence, explicit review labels, scenario-grouped splits", () => {
    const { messages, gold } = realisticDataset();
    expect(messages).toHaveLength(32);
    expect(gold).toHaveLength(32);
    expect(new Set(messages.map((row) => row.id)).size).toBe(32);
    expect(messages.every((row) => row.id.startsWith("rea-"))).toBe(true);
    const byId = realisticMessagesById();
    for (const row of gold) {
      expect(typeof row.reviewRequired).toBe("boolean");
      expect(["tuning", "final"].includes(row.split)).toBe(true);
      expect(byId[row.id]).toBe(messages.find((message) => message.id === row.id)?.message);
      if (row.expected === null) {
        expect(goldRequiresReview(row)).toBe(true);
        continue;
      }
      expect(row.expected.evidence.length).toBeGreaterThan(0);
      const source = byId[row.id]!.toLowerCase();
      for (const quote of row.expected.evidence) {
        expect(quote.trim().length).toBeGreaterThan(0);
        expect(source.includes(quote.trim().toLowerCase())).toBe(true);
      }
    }
    const scenarios = new Set(gold.map((row) => row.scenario));
    for (const required of ["eta-clear", "eta-written-date", "quantity-clear", "multiple-po", "no-reference", "forwarded-correction", "conflicting-dates", "relative-date", "irrelevant", "cancelled"]) {
      expect(scenarios.has(required)).toBe(true);
    }
    const tuning = gold.filter((row) => row.split === "tuning");
    const final = gold.filter((row) => row.split === "final");
    expect(tuning.length).toBeGreaterThanOrEqual(10);
    expect(final.length).toBeGreaterThanOrEqual(10);
    // The duplicate-delivery pair shares text across ids by design; nothing else repeats.
    const texts = messages.map((row) => row.message);
    const duplicates = texts.filter((text, index) => texts.indexOf(text) !== index);
    expect(duplicates).toHaveLength(1);
  });

  it("scores evidence support and splits on the realistic rows", () => {
    const { gold } = realisticDataset();
    const messages = realisticMessagesById();
    const perfect: Record<string, Prediction> = Object.fromEntries(
      gold.filter((row) => row.expected !== null).map((row) => [row.id, row.expected!]),
    );
    const full = evidenceSupport(gold, messages, perfect);
    expect(full.accuracy).toBe(1);

    const tampered = { ...perfect };
    const first = gold.find((row) => row.expected !== null)!;
    tampered[first.id] = { ...first.expected!, evidence: ["this quote is nowhere in the message"] };
    const partial = evidenceSupport(gold, messages, tampered);
    expect(partial.correct).toBe(full.correct - 1);
    expect(partial.total).toBe(full.total);

    const missing = evidenceSupport(gold, messages, {});
    expect(missing).toMatchObject({ correct: 0, total: full.total, accuracy: 0 });

    const bySplit = evaluateBySplit(gold, perfect);
    expect(bySplit.map((row) => row.split).sort()).toEqual(["final", "tuning"]);
  });
});
