import { describe, expect, it, vi } from "vitest";
import { OpenRouterExtractionAdapter, supplierExtractionSystemPrompt } from "../src/openrouter";
import type { PoContextRecord } from "../src/context";

const valid = { poReference: "PO-1001", eta: "2026-04-15", quantity: 12, type: "new_commitment", confidence: 0.92, evidence: ["Ship 12 units on April 15."] };
const mockResponse = (content: string) => ({ ok: true, json: async () => ({ id: "resp-1", model: "provider/model-routed", usage: { prompt_tokens: 8, completion_tokens: 13, total_tokens: 21 }, choices: [{ finish_reason: "stop", message: { content } }] }) });
const poContext: PoContextRecord[] = [{
  poId: "PO-1001",
  sourceDataset: "supply-chain",
  supplierId: "SUP1",
  supplierName: "Acme Parts",
  materialId: "PROD1",
  productName: null,
  itemCategory: null,
  orderDate: "2024-03-19",
  plannedDeliveryDate: "2024-04-02",
  actualDeliveryDate: null,
  quantity: 10,
  unitCost: 42.5,
  negotiatedPrice: null,
  totalCost: 425,
  orderStatus: null,
  defectiveUnits: null,
  compliance: null,
  supplierOnTimeRate: null,
  preferredSupplier: null,
  provenance: { sourceDataset: "supply-chain", sourceFile: "procurement_orders.csv" },
}];

describe("OpenRouterExtractionAdapter", () => {
  it("sends strict text extraction payload and returns validated output with usage and safe metadata", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(JSON.stringify(valid)));
    const adapter = new OpenRouterExtractionAdapter({ apiKey: "injected-test-secret", fetch: fetch as typeof globalThis.fetch });
    const result = await adapter.extractWithResponse("We will ship 12 units.");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer injected-test-secret");
    const sent = JSON.parse(init?.body as string);
    expect(sent.model).toBe("~z-ai/glm-flash-latest");
    expect(sent.messages[1].content).toBe("We will ship 12 units.");
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(result).toMatchObject({ output: valid, usage: { promptTokens: 8, completionTokens: 13, totalTokens: 21 }, response: { id: "resp-1", model: "provider/model-routed", finishReason: "stop" } });
    expect(result.request.model).toBe("~z-ai/glm-flash-latest");
    expect(JSON.stringify(result)).not.toContain("injected-test-secret");
  });

  it("sends image bytes as a MIME-qualified data URI and honors model/endpoint overrides", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(JSON.stringify(valid)));
    const adapter = new OpenRouterExtractionAdapter({ apiKey: "test", model: "custom-model", endpoint: "https://example.test/chat", fetch: fetch as typeof globalThis.fetch });
    await adapter.extractImage(new Uint8Array([65, 66]), "image/png");
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/chat");
    const sent = JSON.parse(init?.body as string);
    expect(sent.model).toBe("custom-model");
    expect(sent.messages[1].content[1]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,QUI=" } });
  });

  it("rejects unsuccessful responses, malformed JSON, and schema-invalid output", async () => {
    const badHttp = new OpenRouterExtractionAdapter({ apiKey: "test", fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) as typeof globalThis.fetch });
    await expect(badHttp.extract("hello")).rejects.toThrow("OpenRouter request failed (401)");
    const malformed = new OpenRouterExtractionAdapter({ apiKey: "test", fetch: vi.fn().mockResolvedValue(mockResponse("not json")) as typeof globalThis.fetch });
    await expect(malformed.extract("hello")).rejects.toThrow("malformed structured JSON");
    const invalid = new OpenRouterExtractionAdapter({ apiKey: "test", fetch: vi.fn().mockResolvedValue(mockResponse(JSON.stringify({ ...valid, confidence: 5 }))) as typeof globalThis.fetch });
    await expect(invalid.extract("hello")).rejects.toThrow();
  });

  it("sends PO facts as delimited context while preserving the original message", async () => {
    const fetch = vi.fn().mockResolvedValue(mockResponse(JSON.stringify(valid)));
    const adapter = new OpenRouterExtractionAdapter({ apiKey: "test", fetch: fetch as typeof globalThis.fetch });
    await adapter.extractWithResponse("Revised delivery is 2024-04-10.", poContext);
    const sent = JSON.parse(fetch.mock.calls[0]![1]!.body as string);
    const userContent = sent.messages[1].content as string;
    expect(userContent).toContain("<po_context>");
    expect(userContent).toContain("poId=PO-1001");
    expect(userContent).toContain("<supplier_message>\nRevised delivery is 2024-04-10.\n</supplier_message>");
  });

  it("uses a prompt taxonomy that separates new commitments from explicit changes", () => {
    expect(supplierExtractionSystemPrompt).toContain("new_commitment");
    expect(supplierExtractionSystemPrompt).toContain("eta_change");
    expect(supplierExtractionSystemPrompt).toContain("quantity_change");
    expect(supplierExtractionSystemPrompt).toContain("general_update");
    expect(supplierExtractionSystemPrompt).toContain("explicitly revises");
    expect(supplierExtractionSystemPrompt).toContain("untrusted evidence");
  });
});
