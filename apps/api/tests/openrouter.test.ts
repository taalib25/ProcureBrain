import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/store";
import { OpenRouterExtractionAdapter, type OpenRouterResult } from "../../../packages/ai/src/openrouter";
import type { PoContextRecord } from "../../../packages/ai/src/context";
import type { ConfiguredAIProvider, SafeProviderResponse } from "../../../packages/ai/src/configured-provider";

const model = "test/openrouter-vision";
const apiKey = "test-secret-that-must-not-leak";
const output = {
  poReference: "PO-1001",
  eta: "2025-06-12",
  quantity: null,
  type: "eta_change",
  confidence: 0.96,
  evidence: ["We will deliver PO-1001 on 2025-06-12."],
};

function mockResponse(content = output) {
  return new Response(JSON.stringify({
    id: "gen-test-1",
    model,
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(content) } }],
    usage: { prompt_tokens: 31, completion_tokens: 14, total_tokens: 45 },
  }), { status: 200, headers: { "content-type": "application/json" } });
}

function configuredProvider(fetcher: typeof globalThis.fetch): ConfiguredAIProvider {
  const adapter = new OpenRouterExtractionAdapter({ apiKey, model, fetch: fetcher });
  let lastResponse: SafeProviderResponse | null = null;
  const extractionAdapter = {
    extract: async (message: string, poContext: readonly PoContextRecord[] = []) => {
      const result = await adapter.extractWithResponse(message, poContext);
      lastResponse = toSafeResponse(result);
      return result.output;
    },
    get lastResponse() { return lastResponse; },
  };
  return {
    provider: "openrouter",
    model,
    configured: true,
    configurationError: null,
    extractionAdapter,
    visionAdapter: {
      extract: async (image: Uint8Array, mimeType: string) => {
        const result = await adapter.extractWithResponse([
          { type: "text", text: "Extract a supplier commitment from this image." },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${Buffer.from(image).toString("base64")}` } },
        ]);
        lastResponse = toSafeResponse(result);
        return { output: result.output, usage: usage(result), response: result.response };
      },
    },
  };
}

function usage(result: OpenRouterResult) {
  return {
    inputTokens: result.usage.promptTokens,
    outputTokens: result.usage.completionTokens,
    totalTokens: result.usage.totalTokens,
  };
}

function toSafeResponse(result: OpenRouterResult): SafeProviderResponse {
  return { usage: usage(result), response: result.response };
}

describe("OpenRouter API integration", () => {
  it("returns a valid supplier proposal with usage and caches the identical request without mutating events", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse());
    const store = new MemoryStore();
    const eventsBefore = structuredClone(store.allEvents());
    const app = createApp(store, { configuredProvider: configuredProvider(fetcher) });
    const send = () => app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "We will deliver PO-1001 on 2025-06-12." }),
    });

    const first = await send();
    const result = await first.json() as {
      proposal: { state: string; commitment: typeof output };
      cacheHit: boolean;
      status: string;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    expect(first.status).toBe(200);
    expect(result.proposal.state).toBe("VALID");
    expect(result.proposal.commitment).toMatchObject(output);
    expect(result.cacheHit).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.usage).toEqual({ inputTokens: 31, outputTokens: 14, totalTokens: 45 });

    const requestPayload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(requestPayload.model).toBe(model);
    expect(requestPayload.response_format).toMatchObject({ type: "json_schema", json_schema: { strict: true, name: "supplier_commitment" } });
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: `Bearer ${apiKey}` });

    const second = await send();
    const replay = await second.json() as { cacheHit: boolean; usage: { totalTokens: number }; runUsage: { totalTokens: number } };
    expect(replay.cacheHit).toBe(true);
    expect(replay.usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(replay.runUsage.totalTokens).toBe(45);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.allEvents()).toEqual(eventsBefore);
  });

  it("sends an image_url vision payload only after local OCR fails", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse());
    const store = new MemoryStore();
    const app = createApp(store, {
      configuredProvider: configuredProvider(fetcher),
      ocrAdapter: { extract: vi.fn(async () => { throw new Error("image decode failed"); }) },
    });
    const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const response = await app.request("/api/analysis/image", {
      method: "POST",
      headers: { "content-type": "image/png", "idempotency-key": "openrouter-image-test" },
      body: image,
    });
    const result = await response.json() as {
      run: { result: { tier: string; reviewRequired: boolean }; fallbackTier: string; usage: { totalTokens: number } };
      cacheHit: boolean;
      usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    };
    expect(response.status).toBe(200);
    expect(result.cacheHit).toBe(false);
    expect(result.run.result.tier).toBe("vision_fallback");
    expect(result.run.result.reviewRequired).toBe(false);
    expect(result.run.fallbackTier).toBe("vision_after_ocr_failure");
    expect(result.usage).toEqual({ inputTokens: 31, outputTokens: 14, totalTokens: 45 });

    const requestPayload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(requestPayload.model).toBe(model);
    expect(requestPayload.messages[1].content).toContainEqual({
      type: "image_url",
      image_url: { url: `data:image/png;base64,${Buffer.from(image).toString("base64")}` },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.allEvents()).toHaveLength(6);
  });

  it("sends validated PO context with the message and caches context distinctly from no-context", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse());
    const store = new MemoryStore();
    const app = createApp(store, { configuredProvider: configuredProvider(fetcher) });
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
    const send = (body: Record<string, unknown>) => app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = "PO-1001 revised delivery is 2025-06-20.";

    const first = await send({ text, poContext });
    expect(first.status).toBe(200);
    const firstResult = await first.json() as { proposal: { state: string; sourceText: string }; cacheHit: boolean };
    expect(firstResult.proposal.state).toBe("VALID");
    expect(firstResult.proposal.sourceText).toBe(text);
    expect(firstResult.cacheHit).toBe(false);
    const payload = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    expect(String(payload.messages[1].content)).toContain("<po_context>");
    expect(String(payload.messages[1].content)).toContain("poId=PO-1001");
    expect(String(payload.messages[1].content)).toContain(`<supplier_message>\n${text}\n</supplier_message>`);

    const replay = await send({ text, poContext });
    expect(((await replay.json()) as { cacheHit: boolean }).cacheHit).toBe(true);

    const noContext = await send({ text });
    expect(((await noContext.json()) as { cacheHit: boolean }).cacheHit).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid PO context and keeps ambiguous matches reviewable", async () => {
    const fetcher = vi.fn<typeof globalThis.fetch>().mockResolvedValue(mockResponse());
    const store = new MemoryStore();
    const eventsBefore = structuredClone(store.allEvents());
    const app = createApp(store, { configuredProvider: configuredProvider(fetcher) });

    const invalid = await app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Update.", poContext: [{ bad: true }] }),
    });
    expect(invalid.status).toBe(400);

    const ambiguous = await app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Which order?", matchingPoCount: 2, poContext: [] }),
    });
    expect(ambiguous.status).toBe(200);
    expect(((await ambiguous.json()) as { proposal: { state: string } }).proposal.state).toBe("AMBIGUOUS_PO");
    expect(store.allEvents()).toEqual(eventsBefore);
  });
});

describe("selected-PO baseline and email candidate matching", () => {
  it("injects the live PO baseline into model context when a PO is selected", async () => {
    let seenContext: readonly PoContextRecord[] = [];
    const store = new MemoryStore();
    const state = store.state("po-1")!;
    const reference = store.purchaseOrderReference("po-1")!;
    const app = createApp(store, {
      extractionAdapter: {
        extract: async (_message: string, poContext: readonly PoContextRecord[] = []) => {
          seenContext = poContext;
          return { ...output, poReference: reference.poNumber };
        },
      },
    });
    const response = await app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "PO-1001 revised delivery is 2026-11-10.", entityId: "po-1" }),
    });
    expect(response.status).toBe(200);
    const result = await response.json() as { baseline: { poReference: string; eta: string | null }; poCandidates: unknown[] };
    expect(result.baseline).toMatchObject({ poReference: reference.poNumber, eta: state.eta });
    expect(result.poCandidates).toEqual([]);
    const baseline = seenContext.find((record) => record.provenance.sourceFile === "operational-state");
    expect(baseline).toMatchObject({
      poId: reference.poNumber,
      sourceDataset: "operational",
      plannedDeliveryDate: state.eta,
      supplierName: state.supplierName,
    });
  });

  it("suggests the referenced PO for pasted emails sent without a selection", async () => {
    const store = new MemoryStore();
    const app = createApp(store, {
      extractionAdapter: { extract: async () => ({ ...output, poReference: "PO-1001" }) },
    });
    const matched = await app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Subject: delay\n\nHi, PO-1001 will now arrive 2026-11-10." }),
    });
    expect(matched.status).toBe(200);
    const matchedResult = await matched.json() as { poCandidates: Array<{ entityId: string; poNumber: string }>; baseline: null };
    expect(matchedResult.poCandidates).toEqual([{ entityId: "po-1", poNumber: "PO-1001" }]);
    expect(matchedResult.baseline).toBeNull();

    const unmatched = await app.request("/api/analysis/supplier-text", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Hello, just checking in with no order mentioned." }),
    });
    expect(unmatched.status).toBe(200);
    expect(((await unmatched.json()) as { poCandidates: unknown[] }).poCandidates).toEqual([]);
  });
});
