import { describe, expect, it, vi } from "vitest";
import { createApp, requestOpenAIVision } from "../../../apps/api/src/app";

describe("operational API integration", () => {
  it("sends image bytes as a multimodal OpenAI image_url block without network access", async () => {
    let payload: { messages?: Array<{ content?: Array<{ type?: string; image_url?: { url?: string } }> }> } | undefined;
    const fakeFetch: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ poReference: "PO-1", eta: null, quantity: 1, type: "quantity_change", confidence: 0.9, evidence: ["qty 1"] }) } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const result = await requestOpenAIVision(new Uint8Array([0, 1, 2]), "image/png", "vision-test", fakeFetch);
    expect(payload?.messages?.[1]?.content?.[0]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } });
    expect(result.usage?.totalTokens).toBe(5);
  });

  it("imports CSV once, projects PO state and attention, and retains source evidence", async () => {
    const app = createApp();
    const csv = "po,event_type,occurred_at,quantity\nPO-X77,PO_CREATED,2025-01-01T00:00:00Z,10";
    const send = () => app.request("/api/imports/purchase-orders", { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
    const [first, duplicate] = await Promise.all([send(), send()]);
    const a = await first.json() as { sourceRecordId: string; inserted: number };
    const b = await duplicate.json() as { sourceRecordId: string; inserted: number };
    expect(a.sourceRecordId).toBe(b.sourceRecordId);
    expect(a.inserted + b.inserted).toBe(1);
    const updateCsv = "po,event_type,occurred_at,quantity\nPO-X77,QUANTITY_REDUCED,2025-01-02T00:00:00Z,4";
    await app.request("/api/imports/supplier-updates", { method: "POST", headers: { "content-type": "text/csv" }, body: updateCsv });
    const orders = await (await app.request("/api/purchase-orders")).json() as Array<{ entityId: string; reducedQuantity: number | null }>;
    const importedPo = orders.find((po) => po.entityId.toLowerCase().includes("x77"));
    expect(importedPo?.reducedQuantity).toBe(4);
    const source = await (await app.request(`/api/sources/${a.sourceRecordId}`)).json() as { content: string; evidence: unknown[] };
    expect(source.content).toBe(csv);
    expect(source.evidence).toHaveLength(1);
    const attention = await (await app.request("/api/exceptions")).json() as Array<{ entityId: string }>;
    expect(attention.some((item) => item.entityId === importedPo?.entityId)).toBe(true);
    const csvAnalysisBody = JSON.stringify({ csv, sourceRecordId: "deterministic-eval" });
    const csvAnalysis = await app.request("/api/analysis/csv", { method: "POST", headers: { "content-type": "application/json" }, body: csvAnalysisBody });
    expect((await csvAnalysis.json() as { usage: { totalTokens: number } }).usage.totalTokens).toBe(0);
  });

  it("runs OCR before text extraction, skips vision on OCR success, and replays document results from cache", async () => {
    const vision = vi.fn(async () => ({ output: { poReference: "PO-1", eta: "2025-03-10", quantity: null, type: "eta_change", confidence: 0.95, evidence: ["ETA 2025-03-10"] } }));
    const ocr = vi.fn(async () => ({ text: "Supplier update: PO-1 ETA 2025-03-10", confidence: 0.98, pages: [{ pageIndex: 0, width: 100, height: 200, text: "Supplier update: PO-1 ETA 2025-03-10", confidence: 0.98, blocks: [{ text: "ETA 2025-03-10", label: "text", bbox: [1, 2, 3, 4], confidence: 0.98 }] }] }));
    const extraction = vi.fn(async (message: string) => {
      expect(message).toContain("PO-1 ETA 2025-03-10");
      return { poReference: "PO-1", eta: "2025-03-10", quantity: null, type: "eta_change", confidence: 0.95, evidence: ["ETA 2025-03-10"] };
    });
    const app = createApp(undefined, { visionAdapter: { extract: vision }, ocrAdapter: { extract: ocr }, extractionAdapter: { extract: extraction } });
    const call = () => app.request("/api/analysis/image", { method: "POST", headers: { "content-type": "image/png", "idempotency-key": "vision-eval" }, body: new Uint8Array([1, 2, 3]) });
    const first = await call(); const second = await call();
    const firstResult = await first.json() as { run: { cacheKey: string; result: { tier: string; ocr: { pages: Array<{ blocks: Array<{ bbox: number[]; confidence: number }> }> } } } };
    expect(firstResult.run.result.tier).toBe("ocr_text_model");
    expect(firstResult.run.result.ocr.pages[0].blocks[0]).toMatchObject({ bbox: [1, 2, 3, 4], confidence: 0.98 });
    expect((await second.json() as { cacheHit: boolean }).cacheHit).toBe(true);
    const retryReplay = await app.request("/api/analysis/image?retry=true", { method: "POST", headers: { "content-type": "image/png", "idempotency-key": "vision-eval" }, body: new Uint8Array([1, 2, 3]) });
    expect((await retryReplay.json() as { cacheHit: boolean }).cacheHit).toBe(true);
    expect((await app.request(`/api/analysis/runs/${firstResult.run.cacheKey}/retry`, { method: "POST" })).status).toBe(409);
    expect(vision).not.toHaveBeenCalled();
    expect(ocr).toHaveBeenCalledTimes(1);
    expect(extraction).toHaveBeenCalledTimes(1);
  });

  it("uses deterministic OCR only as a reviewable proposal and never vision-falls back for PDFs", async () => {
    const vision = vi.fn(async () => ({ output: { poReference: null, eta: null, quantity: null, type: "general_update", confidence: 0.2, evidence: ["unclear"] } }));
    const app = createApp(undefined, { visionAdapter: { extract: vision }, ocrAdapter: { extract: async () => "PO-22 ETA 2025-04-06 quantity: 8" } });
    const resultResponse = await app.request("/api/analysis/image", { method: "POST", headers: { "content-type": "image/png", "idempotency-key": "ocr-eval" }, body: new Uint8Array([9]) });
    const result = await resultResponse.json() as { run: { result: { tier: string; commitment: { eta: string; quantity: number } }; fallbackTier: string } };
    expect(result.run.result.tier).toBe("ocr_deterministic");
    expect(result.run.result.commitment).toMatchObject({ eta: "2025-04-06", quantity: 8 });
    expect(result.run.fallbackTier).toBe("ocr_deterministic");

    expect(vision).not.toHaveBeenCalled();
    const pdfVision = vi.fn(async () => ({ output: { poReference: "PO-9", eta: null, quantity: 1, type: "quantity_change", confidence: 0.99, evidence: ["qty 1"] } }));
    const reviewApp = createApp(undefined, { visionAdapter: { extract: pdfVision }, extractionAdapter: { extract: () => null }, ocrAdapter: { extract: async () => { throw new Error("OCR unavailable"); } } });
    const reviewResponse = await reviewApp.request("/api/analysis/document", { method: "POST", headers: { "content-type": "application/pdf" }, body: new Uint8Array([4]) });
    const review = await reviewResponse.json() as { run: { status: string; result: { tier: string; reviewRequired: boolean }; fallbackTier: string } };
    expect(review.run.status).toBe("needs_review");
    expect(review.run.result).toMatchObject({ tier: "review", reviewRequired: true });
    expect(review.run.fallbackTier).toBe("ocr_unavailable");
    expect(pdfVision).not.toHaveBeenCalled();
  });

  it("uses vision only after image OCR fails", async () => {
    const vision = vi.fn(async () => ({ output: { poReference: "PO-5", eta: "2025-04-10", quantity: null, type: "eta_change", confidence: 0.9, evidence: ["ETA 2025-04-10"] } }));
    const app = createApp(undefined, { visionAdapter: { extract: vision }, ocrAdapter: { extract: async () => { throw new Error("decode failed"); } } });
    const response = await app.request("/api/analysis/image", { method: "POST", headers: { "content-type": "image/png" }, body: new Uint8Array([4]) });
    const body = await response.json() as { run: { result: { tier: string; reviewRequired: boolean }; fallbackTier: string } };
    expect(body.run.result).toMatchObject({ tier: "vision_fallback", reviewRequired: false });
    expect(body.run.fallbackTier).toBe("vision_after_ocr_failure");
    expect(vision).toHaveBeenCalledOnce();
  });

  it("sends PDF OCR text to the text extractor and never calls vision", async () => {
    const vision = vi.fn(async () => ({ output: null }));
    const extraction = vi.fn(async (message: string) => {
      expect(message).toContain("PO-88 ETA 2025-05-14");
      return { poReference: "PO-88", eta: "2025-05-14", quantity: null, type: "eta_change", confidence: 0.94, evidence: ["ETA 2025-05-14"] };
    });
    const app = createApp(undefined, {
      visionAdapter: { extract: vision },
      extractionAdapter: { extract: extraction },
      ocrAdapter: { extract: async () => ({ text: "PO-88 ETA 2025-05-14", confidence: 0.93, pages: [{ pageIndex: 0, width: 500, height: 700, text: "PO-88 ETA 2025-05-14", confidence: 0.93, blocks: [] }] }) },
    });
    const response = await app.request("/api/analysis/document", { method: "POST", headers: { "content-type": "application/pdf" }, body: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
    const body = await response.json() as { run: { status: string; result: { tier: string; ocr: { pages: Array<{ pageIndex: number }> } } } };
    expect(body.run.status).toBe("needs_review");
    expect(body.run.result.tier).toBe("ocr_text_model");
    expect(body.run.result.ocr.pages[0].pageIndex).toBe(0);
    expect(extraction).toHaveBeenCalledOnce();
    expect(vision).not.toHaveBeenCalled();
  });
});
