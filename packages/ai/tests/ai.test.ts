import { describe, expect, it, vi } from "vitest";
import { proposeCachedSupplierCommitment, proposeSupplierCommitment, structuredExtractionAdapter } from "../src/adapter";
import { MemoryAnalysisCache } from "../../analysis-cache/src";
import { SupplierCommitmentSchema } from "../src/schema";
import type { PoContextRecord } from "../src/context";
import { extractCachedSupplierCommitmentFromImage, extractSupplierCommitmentFromImage } from "../src/image";
import { OpenAIExtractionAdapter } from "../src/openai";

const valid = {
  poReference: "PO-1001",
  eta: "2026-04-15",
  quantity: 12,
  type: "new_commitment" as const,
  confidence: 0.92,
  evidence: ["We will ship 12 units on April 15, 2026."],
};

describe("supplier commitment contract", () => {
  it("uses vision first, falls back to OCR only for invalid/low-confidence vision, and reviews unresolved output", async () => {
    const vision = vi.fn().mockResolvedValue(valid);
    const ocr = vi.fn().mockResolvedValue(valid);
    const primary = await extractSupplierCommitmentFromImage("image-bytes", { vision: { extract: vision }, ocr: { extract: ocr } });
    expect(primary.tier).toBe("vision");
    expect(vision).toHaveBeenCalledTimes(1);
    expect(ocr).not.toHaveBeenCalled();

    const lowVision = vi.fn().mockResolvedValue({ ...valid, confidence: 0.2 });
    const fallbackOcr = vi.fn().mockResolvedValue(valid);
    const fallback = await extractSupplierCommitmentFromImage("image-bytes", { vision: { extract: lowVision }, ocr: { extract: fallbackOcr } });
    expect(fallback.tier).toBe("ocr");
    expect(lowVision).toHaveBeenCalledTimes(1);
    expect(fallbackOcr).toHaveBeenCalledTimes(1);

    const unresolvedOcr = vi.fn().mockResolvedValue({ ...valid, confidence: 0.2 });
    const review = await extractSupplierCommitmentFromImage("image-bytes", { vision: { extract: () => ({ bad: true }) }, ocr: { extract: unresolvedOcr } });
    expect(review).toMatchObject({ tier: "review", reviewRequired: true });
  });

  it("replays cached image tier decisions without calling vision or OCR again", async () => {
    const cache = new MemoryAnalysisCache<Awaited<ReturnType<typeof extractSupplierCommitmentFromImage>>>();
    const vision = vi.fn().mockRejectedValue(new Error("offline"));
    const ocr = vi.fn().mockResolvedValue(valid);
    const options = { cache, model: "vision-v1", provider: "openai", promptVersion: "p1", schemaVersion: "s1", vision: { extract: vision }, ocr: { extract: ocr } };
    const first = await extractCachedSupplierCommitmentFromImage("image-data", options, { sourceRecordId: "img-1" });
    const second = await extractCachedSupplierCommitmentFromImage("image-data", options, { sourceRecordId: "img-1" });
    expect(first.result.tier).toBe("ocr");
    expect(second.cacheHit).toBe(true);
    expect(vision).toHaveBeenCalledTimes(1);
    expect(ocr).toHaveBeenCalledTimes(1);
  });

  it("sends a strict structured-output request to OpenAI and validates the response", async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(valid) } }] }) });
    const adapter = new OpenAIExtractionAdapter({ apiKey: "test-key", fetch: fetch as typeof globalThis.fetch });
    expect(await adapter.extract("Confirmed." )).toEqual(valid);
    const request = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    expect(request.response_format.json_schema.strict).toBe(true);
    expect(request.response_format.json_schema.schema.additionalProperties).toBe(false);
  });
  it("accepts nullable fields and rejects unknown fields", () => {
    expect(SupplierCommitmentSchema.parse({ ...valid, eta: null, quantity: null })).toEqual({ ...valid, eta: null, quantity: null });
    expect(SupplierCommitmentSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
    expect(SupplierCommitmentSchema.safeParse({ ...valid, confidence: 1.1 }).success).toBe(false);
  });

  it("returns a valid proposal without persisting an event", async () => {
    const proposal = await proposeSupplierCommitment("Confirmed.", { sourceRecordId: "msg-1", entityId: "po-1", matchingPoCount: 1 }, structuredExtractionAdapter(valid));
    expect(proposal.state).toBe("VALID");
    expect(proposal.commitment).toEqual(valid);
    expect(proposal).not.toHaveProperty("event");
  });

  it("marks malformed, ambiguous, unknown, low-confidence, and duplicate inputs for review", async () => {
    const malformed = await proposeSupplierCommitment("bad", { sourceRecordId: "msg-2" }, structuredExtractionAdapter({ ...valid, quantity: "twelve" }));
    const ambiguous = await proposeSupplierCommitment("which PO?", { sourceRecordId: "msg-3", matchingPoCount: 2 }, structuredExtractionAdapter(valid));
    const unknown = await proposeSupplierCommitment("unknown", { sourceRecordId: "msg-4", matchingPoCount: 0 }, structuredExtractionAdapter(valid));
    const low = await proposeSupplierCommitment("maybe", { sourceRecordId: "msg-5", matchingPoCount: 1 }, structuredExtractionAdapter({ ...valid, confidence: 0.2 }));
    const duplicate = await proposeSupplierCommitment("repeat", { sourceRecordId: "msg-6", sourceAlreadyProcessed: true }, structuredExtractionAdapter(valid));
    expect(malformed.state).toBe("INVALID_SCHEMA");
    expect(ambiguous.state).toBe("AMBIGUOUS_PO");
    expect(unknown.state).toBe("UNKNOWN_PO");
    expect(low.state).toBe("LOW_CONFIDENCE");
    expect(duplicate.state).toBe("DUPLICATE_SOURCE");
  });

  it("caches the complete supplier proposal and avoids a second model call", async () => {
    const cache = new MemoryAnalysisCache<Awaited<ReturnType<typeof proposeSupplierCommitment>>>();
    const model = vi.fn(() => structuredExtractionAdapter(valid));
    const options = { cache, model: "model-v1", provider: "test", promptVersion: "prompt-1", schemaVersion: "schema-1" };

    const first = await proposeCachedSupplierCommitment("Confirmed.", { sourceRecordId: "cached-1", entityId: "po-1", matchingPoCount: 1 }, { extract: () => model().extract("Confirmed.") }, options);
    const second = await proposeCachedSupplierCommitment("Confirmed.", { sourceRecordId: "cached-1", entityId: "po-1", matchingPoCount: 1 }, { extract: () => model().extract("Confirmed.") }, options);

    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(model).toHaveBeenCalledTimes(1);
    expect(second.proposal.state).toBe("VALID");
  });
});

const poContext: PoContextRecord[] = [{
  poId: "PO-1001",
  sourceDataset: "supply-chain",
  supplierId: "SUP1",
  supplierName: "Acme Parts",
  materialId: null,
  productName: null,
  itemCategory: null,
  orderDate: "2024-03-19",
  plannedDeliveryDate: "2024-04-02",
  actualDeliveryDate: null,
  quantity: 10,
  unitCost: null,
  negotiatedPrice: null,
  totalCost: null,
  orderStatus: null,
  defectiveUnits: null,
  compliance: null,
  supplierOnTimeRate: null,
  preferredSupplier: null,
  provenance: { sourceDataset: "supply-chain", sourceFile: "procurement_orders.csv" },
}];

describe("supplier extraction with PO context", () => {
  it("forwards validated context to the adapter while keeping the message as proposal source", async () => {
    const extract = vi.fn().mockResolvedValue(valid);
    const proposal = await proposeSupplierCommitment(
      "Revised delivery is 2024-04-10.",
      { sourceRecordId: "ctx-1", entityId: "po-1", matchingPoCount: 1 },
      { extract },
      { poContext },
    );
    expect(extract).toHaveBeenCalledWith("Revised delivery is 2024-04-10.", poContext);
    expect(proposal.sourceText).toBe("Revised delivery is 2024-04-10.");
    expect(proposal.state).toBe("VALID");
  });

  it("marks invalid purchase-order context as reviewable without calling the model", async () => {
    const extract = vi.fn().mockResolvedValue(valid);
    const proposal = await proposeSupplierCommitment(
      "Revised delivery is 2024-04-10.",
      { sourceRecordId: "ctx-2" },
      { extract },
      { poContext: [{ bad: true }] as unknown as PoContextRecord[] },
    );
    expect(proposal.state).toBe("INVALID_SCHEMA");
    expect(proposal.commitment).toBeNull();
    expect(extract).not.toHaveBeenCalled();
  });

  it("caches context and no-context extractions under distinct identities", async () => {
    const cache = new MemoryAnalysisCache<Awaited<ReturnType<typeof proposeSupplierCommitment>>>();
    const options = { cache, model: "model-v1", provider: "test", promptVersion: "prompt-1", schemaVersion: "schema-1" };
    const extract = vi.fn().mockResolvedValue(valid);
    const adapter = { extract };
    const context = { sourceRecordId: "ctx-3", entityId: "po-1", matchingPoCount: 1 };

    const plain = await proposeCachedSupplierCommitment("Revised delivery is 2024-04-10.", context, adapter, options);
    const withContext = await proposeCachedSupplierCommitment("Revised delivery is 2024-04-10.", context, adapter, options, { poContext });
    const withContextReplay = await proposeCachedSupplierCommitment("Revised delivery is 2024-04-10.", context, adapter, options, { poContext });

    expect(plain.cacheHit).toBe(false);
    expect(withContext.cacheHit).toBe(false);
    expect(withContextReplay.cacheHit).toBe(true);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(withContext.proposal.sourceText).toBe("Revised delivery is 2024-04-10.");
  });

  it("keeps ambiguous and unknown outcomes reviewable when context is present", async () => {
    const ambiguous = await proposeSupplierCommitment(
      "Which order?",
      { sourceRecordId: "ctx-4", matchingPoCount: 2 },
      structuredExtractionAdapter(valid),
      { poContext },
    );
    const unknown = await proposeSupplierCommitment(
      "Unknown order",
      { sourceRecordId: "ctx-5", matchingPoCount: 0 },
      structuredExtractionAdapter(valid),
      { poContext },
    );
    expect(ambiguous.state).toBe("AMBIGUOUS_PO");
    expect(unknown.state).toBe("UNKNOWN_PO");
  });
});
