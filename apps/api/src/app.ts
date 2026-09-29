import { Hono } from "hono";
import type { Context } from "hono";
import type { Event } from "../../../packages/domain/src/events";
import { normalizeCsv, type PurchaseOrderReference } from "../../../packages/ingestion/src";
import { analysisCacheKey, MemoryAnalysisCache, runCachedAnalysis, type AnalysisRun, type DurableAnalysisCache } from "../../../packages/analysis-cache/src";
import { type ExtractionAdapter } from "../../../packages/ai/src/adapter";
import { SupplierCommitmentSchema } from "../../../packages/ai/src/schema";
import { PoContextArraySchema } from "../../../packages/ai/src/context";
import type { EventProposal } from "../../../packages/ai/src/schema";
import { proposeSupplierCommitment } from "../../../packages/ai/src/adapter";
import { createConfiguredAIProvider, type ConfiguredAIProvider } from "../../../packages/ai/src/configured-provider";
import { createPaddleOcrAdapter, type OcrDocument } from "./paddleocr";
import type { MemoryStore, PostgresStore } from "./store";

const MAX_BODY = 5 * 1024 * 1024;
type ApiStore = MemoryStore | PostgresStore;
export interface VisionAdapter {
  extract(image: Uint8Array, mimeType: string): Promise<{ output: unknown; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }>;
}
export interface OcrAdapter { extract(image: Uint8Array, mimeType: string): Promise<string | OcrDocument> }
interface AppOptions { cache?: MemoryAnalysisCache<unknown>; durableCache?: DurableAnalysisCache<unknown>; extractionAdapter?: ExtractionAdapter; visionAdapter?: VisionAdapter; ocrAdapter?: OcrAdapter; configuredProvider?: ConfiguredAIProvider; storageMode?: "memory" | "postgres" }

export function createApp(store: ApiStore = new (requireMemoryStore())(), options: AppOptions = {}) {
  const app = new Hono();
  const cache = options.cache ?? new MemoryAnalysisCache<unknown>();
  const durable = options.durableCache;
  const documentOcr = options.ocrAdapter ?? createPaddleOcrAdapter();
  // Keep provider response metadata request-scoped; configured adapters retain their last response.
  const getConfiguredProvider = () => options.configuredProvider ?? createConfiguredAIProvider(process.env);
  const memoryStore = store instanceof (requireMemoryStore());
  const asyncCall = async <T>(fn: () => T | Promise<T>) => await fn();
  app.get("/api/health", (c) => c.json({ ok: true, storage: options.storageMode ?? (memoryStore ? "memory" : "postgres") }));
  app.get("/api/purchase-orders", async (c) => c.json(await asyncCall(() => store.purchaseOrders())));
  app.get("/api/purchase-orders/:id", async (c) => { const state = await asyncCall(() => store.state(c.req.param("id"))); return state ? c.json(state) : c.json({ error: "Purchase order not found" }, 404); });
  app.get("/api/purchase-orders/:id/timeline", async (c) => c.json(await asyncCall(() => store.timeline(c.req.param("id")))));
  app.get("/api/exceptions", async (c) => c.json(await asyncCall(() => store.exceptions())));

  const importHandler = async (c: Context, sourceType: string) => {
    const contentType = c.req.header("content-type") ?? "";
    const explicitId = c.req.header("idempotency-key") ?? c.req.header("x-source-record-id");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_BODY) return c.json({ error: "Request body too large" }, 413);
    if (contentType.includes("text/csv")) {
      const raw = await readLimited(c.req.raw);
      if (raw === null) return c.json({ error: "Request body too large" }, 413);
      const csv = new TextDecoder().decode(raw);
      const id = explicitId ?? `source-${sha256(`${sourceType}\n${csv}`)}`;
      return c.json(await store.importCsv(csv, id, sourceType));
    }
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let body: { csv?: string; sourceRecordId?: string; rows?: Array<{ row: number; values: Record<string, string> }> };
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    if (body.csv) return c.json(await store.importCsv(body.csv, body.sourceRecordId ?? explicitId ?? `source-${sha256(`${sourceType}\n${body.csv}`)}`, sourceType));
    if (body.rows) return c.json(await store.importRows(body.rows, body.sourceRecordId ?? explicitId ?? `source-${sha256(`${sourceType}\n${JSON.stringify(body.rows)}`)}`, sourceType));
    return c.json({ error: "Expected csv or rows" }, 400);
  };
  app.post("/api/imports/purchase-orders", (c) => importHandler(c, "purchase_orders"));
  app.post("/api/imports/supplier-updates", (c) => importHandler(c, "supplier_updates"));
  app.post("/api/imports/receipts", (c) => importHandler(c, "receipts"));
  app.post("/api/imports/followups", (c) => importHandler(c, "followups"));
  app.get("/api/sources", async (c) => c.json(await asyncCall(() => memoryStore ? (store as MemoryStore).sources() : (store as PostgresStore).sources())));
  app.get("/api/sources/:id", async (c) => {
    const source = await asyncCall(() => memoryStore ? (store as MemoryStore).source(c.req.param("id")) : (store as PostgresStore).source(c.req.param("id")));
    if (!source) return c.json({ error: "Source record not found" }, 404);
    const events = await asyncCall(() => store.allEvents());
    return c.json({ ...source, evidence: events.filter((event) => event.sourceRecordId === c.req.param("id")) });
  });

  app.post("/api/analysis/csv", async (c) => {
    const raw = await readLimited(c.req.raw); if (raw === null) return c.json({ error: "Request body too large" }, 413);
    const body = (() => { try { return JSON.parse(new TextDecoder().decode(raw)) as { csv?: string; sourceRecordId?: string; purchaseOrders?: PurchaseOrderReference[]; retry?: boolean }; } catch { return null; } })();
    if (!body?.csv) return c.json({ error: "Expected csv" }, 400);
    if (new TextEncoder().encode(body.csv).byteLength > MAX_BODY) return c.json({ error: "Request body too large" }, 413);
    const id = body.sourceRecordId ?? "analysis-csv";
    const refs = body.purchaseOrders ?? [];
    const request = { input: body.csv, mediaType: "csv" as const, analysisType: "deterministic_csv_normalization", model: "none", provider: "deterministic", promptVersion: "csv-v1", schemaVersion: "events-v1", context: { id, refs } };
    const result = await runCachedAnalysis(request, cache as MemoryAnalysisCache<NormalizationResult>, { run: async () => ({ result: normalizeCsv(body.csv!, id, refs) }) }, { durable: durable as DurableAnalysisCache<NormalizationResult> | undefined, retryFailed: body.retry });
    return c.json({ ...result, status: result.run.status, usage: result.run.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  });

  app.post("/api/analysis/supplier-text", async (c) => {
    const raw = await readLimited(c.req.raw); if (raw === null) return c.json({ error: "Request body too large" }, 413);
    const body = (() => { try { return JSON.parse(new TextDecoder().decode(raw)) as { text?: string; sourceRecordId?: string; entityId?: string | null; matchingPoCount?: number; poContext?: unknown; retry?: boolean }; } catch { return null; } })();
    if (!body?.text || body.text.length > MAX_BODY) return c.json({ error: "Expected text within size limit" }, 400);
    const parsedPoContext = body.poContext === undefined ? { success: true as const, data: [] as const } : PoContextArraySchema.safeParse(body.poContext);
    if (!parsedPoContext.success) return c.json({ error: "Invalid poContext" }, 400);
    const poContext = parsedPoContext.success ? [...parsedPoContext.data] : [];
    const configuredProvider = getConfiguredProvider();
    const { model, provider } = configuredProvider;
    if (!configuredProvider.configured && !options.extractionAdapter) return c.json({ error: "AI provider is not configured", configurationError: configuredProvider.configurationError }, 503);
    let providerUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    const adapter = options.extractionAdapter ?? configuredProvider.extractionAdapter;
    if (!adapter) return c.json({ error: "No extraction provider configured" }, 503);
    const sourceRecordId = body.sourceRecordId ?? `text-${sha256(body.text)}`;
    const context = { sourceRecordId, entityId: body.entityId, matchingPoCount: body.matchingPoCount };
    const request = { input: poContext.length > 0 ? JSON.stringify({ message: body.text, context, poContext }) : JSON.stringify({ message: body.text, context }), mediaType: "text" as const, analysisType: "supplier_commitment_extraction", model, provider, promptVersion: process.env.AI_PROMPT_VERSION ?? "supplier-v2", schemaVersion: process.env.AI_SCHEMA_VERSION ?? "commitment-v1" };
    const failed = body.retry ? ((durable ? await durable.get(analysisCacheKey(request)) : cache.get(analysisCacheKey(request)))?.status === "failed") : false;
    const got = await runCachedAnalysis(request, cache as MemoryAnalysisCache<EventProposal>, { run: async () => {
      const proposal = await proposeSupplierCommitment(body.text!, context, adapter, { poContext });
      const metadata = options.extractionAdapter ? undefined : configuredProvider.extractionAdapter?.lastResponse;
      const usage = metadata?.usage ? numericUsage(metadata.usage) : providerUsage;
      return { result: proposal, usage, modelRequest: { provider, model, mediaType: "text" }, modelResponse: metadata?.response ?? undefined };
    } }, { durable: durable as DurableAnalysisCache<EventProposal> | undefined, retryFailed: failed });
    return c.json({ proposal: got.run.result, run: got.run, cacheHit: got.cacheHit, status: got.run.status, usage: got.cacheHit ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : got.run.usage ?? null, runUsage: got.run.usage ?? null });
  });

  const documentAnalysisHandler = async (c: Context) => {
    const type = c.req.header("content-type") ?? "";
    const isImage = /^image\/(png|jpeg|webp)$/.test(type);
    const isPdf = type === "application/pdf";
    if (!isImage && !isPdf) return c.json({ error: "Supported document types: image/png, image/jpeg, image/webp, application/pdf" }, 415);
    const bytes = await readLimited(c.req.raw);
    if (bytes === null) return c.json({ error: "Document exceeds size limit" }, 413);
    if (!bytes.length) return c.json({ error: "Document must be non-empty" }, 400);
    const sourceRecordId = c.req.header("idempotency-key") ?? c.req.header("x-source-record-id") ?? `document-${sha256Bytes(bytes)}`;
    const configuredProvider = getConfiguredProvider();
    const { model, provider } = configuredProvider;
    const extractionAdapter = options.extractionAdapter ?? configuredProvider.extractionAdapter;
    const vision = options.visionAdapter ?? configuredProvider.visionAdapter ?? (provider === "openai" && configuredProvider.configured ? { extract: (image: Uint8Array, mime: string) => requestOpenAIVision(image, mime, model) } : undefined);
    if (!configuredProvider.configured && !extractionAdapter && !(isImage && (options.visionAdapter || configuredProvider.visionAdapter))) return c.json({ error: "AI provider is not configured", configurationError: configuredProvider.configurationError }, 503);
    const cacheKeyRequest = { input: bytes, mediaType: isImage ? "image" as const : "other" as const, analysisType: isImage ? "supplier_image" : "supplier_pdf", model, provider, promptVersion: process.env.AI_PROMPT_VERSION ?? "supplier-v2", schemaVersion: process.env.AI_SCHEMA_VERSION ?? "commitment-v1", context: { sourceRecordId, mime: type, ocrEngine: "paddleocr-pp-structure-v3" } };
    const retry = c.req.query("retry") === "true";
    const failed = retry ? ((durable ? await durable.get(analysisCacheKey(cacheKeyRequest)) : cache.get(analysisCacheKey(cacheKeyRequest)))?.status === "failed") : false;
    const analysis = await runCachedAnalysis(cacheKeyRequest, cache as MemoryAnalysisCache<unknown>, { run: async () => {
      let ocrDocument: OcrDocument | null = null;
      let ocrError: string | null = null;
      let ocrText = "";
      try {
        const output = await documentOcr.extract(bytes, type);
        if (typeof output === "string") ocrText = output;
        else { ocrDocument = output; ocrText = output.text; }
        if (!ocrText.trim()) ocrError = "PaddleOCR produced no usable text";
      } catch (error) { ocrError = error instanceof Error ? error.message : "PaddleOCR failed"; }

      if (!ocrError) {
        if (extractionAdapter) {
          try {
            const raw = await extractionAdapter.extract(ocrText);
            const parsed = SupplierCommitmentSchema.safeParse(raw);
            const metadata = options.extractionAdapter ? undefined : configuredProvider.extractionAdapter?.lastResponse;
            const usage = metadata?.usage ? numericUsage(metadata.usage) : undefined;
            if (parsed.success) {
              const needsReview = parsed.data.confidence < 0.7;
              return { result: { commitment: parsed.data, tier: "ocr_text_model", reviewRequired: needsReview, reason: needsReview ? "OCR text extraction confidence below threshold" : null, ocr: ocrDocument }, status: "needs_review" as const, fallbackTier: needsReview ? "ocr_text_model_review" : "ocr_text_model", usage, modelRequest: { provider, model, tier: "text", mimeType: type, inputSource: "paddleocr", ocrText }, modelResponse: metadata?.response ?? { validated: true } };
            }
            return { result: { commitment: null, tier: "review", reviewRequired: true, reason: "OCR text extraction did not match the commitment schema", ocr: ocrDocument }, status: "needs_review" as const, fallbackTier: "ocr_text_model_invalid", usage, modelRequest: { provider, model, tier: "text", mimeType: type, inputSource: "paddleocr", ocrText }, modelResponse: metadata?.response ?? { validated: false } };
          } catch {
            return { result: { commitment: null, tier: "review", reviewRequired: true, reason: "OCR text extraction failed", ocr: ocrDocument }, status: "needs_review" as const, fallbackTier: "ocr_text_model_failed", modelRequest: { provider, model, tier: "text", mimeType: type, inputSource: "paddleocr", ocrText } };
          }
        }
        const extracted = extractCommitmentFromText(ocrText);
        if (extracted) return { result: { commitment: extracted, tier: "ocr_deterministic", reviewRequired: true, reason: "Deterministic extraction requires human review", ocr: ocrDocument }, status: "needs_review" as const, fallbackTier: "ocr_deterministic", modelRequest: { tier: "deterministic", mimeType: type, inputSource: "paddleocr", ocrText } };
        return { result: { commitment: null, tier: "review", reviewRequired: true, reason: "OCR text needs human review", ocr: ocrDocument }, status: "needs_review" as const, fallbackTier: "ocr_review", modelRequest: { tier: "deterministic", mimeType: type, inputSource: "paddleocr", ocrText } };
      }

      if (isImage && vision) {
        try {
          const response = await vision.extract(bytes, type);
          const parsed = SupplierCommitmentSchema.safeParse(response.output);
          const usage = numericUsage(response.usage);
          if (parsed.success) {
            const needsReview = parsed.data.confidence < 0.7;
            return { result: { commitment: parsed.data, tier: "vision_fallback", reviewRequired: needsReview, reason: needsReview ? "Vision fallback confidence below threshold" : null, ocrError }, status: "needs_review" as const, fallbackTier: needsReview ? "vision_fallback_review" : "vision_after_ocr_failure", usage, modelRequest: { provider, model, tier: "vision_fallback", mimeType: type, ocrError }, modelResponse: responseMetadata(response) };
          }
          return { result: { commitment: null, tier: "review", reviewRequired: true, reason: "Vision fallback output did not match the commitment schema", ocrError }, status: "needs_review" as const, fallbackTier: "vision_fallback_invalid", usage, modelRequest: { provider, model, tier: "vision_fallback", mimeType: type, ocrError }, modelResponse: responseMetadata(response) };
        } catch {
          return { result: { commitment: null, tier: "review", reviewRequired: true, reason: "PaddleOCR and image vision fallback failed", ocrError }, status: "needs_review" as const, fallbackTier: "ocr_and_vision_unavailable", modelRequest: { provider, model, tier: "vision_fallback", mimeType: type, ocrError } };
        }
      }
      return { result: { commitment: null, tier: "review", reviewRequired: true, reason: "PaddleOCR failed; PDF documents do not use vision fallback", ocrError }, status: "needs_review" as const, fallbackTier: "ocr_unavailable", modelRequest: { tier: "ocr", mimeType: type, ocrError } };
    } }, { durable: durable as DurableAnalysisCache<unknown> | undefined, retryFailed: failed });
    return c.json({ ...analysis, status: analysis.run.status, usage: analysis.cacheHit ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : analysis.run.usage ?? null, runUsage: analysis.run.usage ?? null });
  };
  app.post("/api/analysis/image", documentAnalysisHandler);
  app.post("/api/analysis/document", documentAnalysisHandler);

  app.get("/api/analysis/runs", async (c) => c.json(memoryStore ? (cache as MemoryAnalysisCache<unknown>).values() : await (store as PostgresStore).analysisRuns()));
  app.get("/api/analysis/runs/:key", async (c) => { const run = durable ? await durable.get(c.req.param("key")) : (cache as MemoryAnalysisCache<unknown>).get(c.req.param("key")); return run ? c.json(run) : c.json({ error: "Analysis run not found" }, 404); });
  app.post("/api/analysis/runs/:key/retry", async (c) => {
    const run = durable ? await durable.get(c.req.param("key")) : (cache as MemoryAnalysisCache<unknown>).get(c.req.param("key"));
    if (!run) return c.json({ error: "Analysis run not found" }, 404);
    if (run.status !== "failed") return c.json({ error: "Only failed runs can be retried" }, 409);
    return c.json({ accepted: true, cacheKey: run.cacheKey, message: "Repeat the original analysis request with retry=true" }, 202);
  });
  return app;
}

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { MemoryStore as DefaultMemoryStore } from "./store";
import type { NormalizationResult } from "../../../packages/ingestion/src";
function requireMemoryStore() { return DefaultMemoryStore; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
function sha256Bytes(value: Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function numericUsage(usage: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null } | undefined) {
  if (!usage) return undefined;
  return compactUsage({ inputTokens: usage.inputTokens ?? undefined, outputTokens: usage.outputTokens ?? undefined, totalTokens: usage.totalTokens ?? undefined });
}
function compactUsage(usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }) {
  return Object.fromEntries(Object.entries(usage).filter(([, value]) => typeof value === "number" && Number.isFinite(value))) as { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}
function responseMetadata(response: { output: unknown; usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null }; response?: unknown }) {
  return response.response ?? undefined;
}
async function readLimited(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); return null; }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return bytes;
}
export async function requestOpenAIVision(bytes: Uint8Array, mimeType: string, model: string, fetcher: typeof globalThis.fetch = globalThis.fetch): Promise<{ output: unknown; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }> {
  const dataUrl = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  const response = await fetcher(process.env.OPENAI_ENDPOINT ?? "https://api.openai.com/v1/chat/completions", {
    method: "POST", headers: { authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [
      { role: "system", content: "Extract a supplier commitment from the image. Use null for absent values, do not infer dates or quantities, and provide exact evidence." },
      { role: "user", content: [{ type: "image_url", image_url: { url: dataUrl } }] },
    ], response_format: { type: "json_schema", json_schema: { name: "supplier_commitment", strict: true, schema: { type: "object", additionalProperties: false, required: ["poReference", "eta", "quantity", "type", "confidence", "evidence"], properties: { poReference: { type: ["string", "null"] }, eta: { type: ["string", "null"] }, quantity: { type: ["number", "null"] }, type: { type: "string", enum: ["new_commitment", "eta_change", "quantity_change", "general_update"] }, confidence: { type: "number" }, evidence: { type: "array", items: { type: "string" }, minItems: 1 } } } } } }),
  });
  if (!response.ok) throw new Error(`OpenAI vision request failed (${response.status})`);
  const result = await response.json() as { choices?: Array<{ message?: { content?: string | null } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } };
  const text = result.choices?.[0]?.message?.content;
  if (!text) throw new Error("OpenAI vision returned no structured content");
  const usage = result.usage ? { inputTokens: result.usage.prompt_tokens, outputTokens: result.usage.completion_tokens, totalTokens: result.usage.total_tokens } : undefined;
  return { output: JSON.parse(text), usage };
}
function extractCommitmentFromText(text: string) {
  const poReference = text.match(/\b(?:PO[- #]?)\w[\w-]*\b/i)?.[0] ?? null;
  const eta = text.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? null;
  const quantityMatch = text.match(/\b(?:qty|quantity)\s*[:#-]?\s*(\d+(?:\.\d+)?)/i);
  if (!poReference && !eta && !quantityMatch) return null;
  const commitment = SupplierCommitmentSchema.safeParse({ poReference, eta, quantity: quantityMatch ? Number(quantityMatch[1]) : null, type: eta ? "eta_change" : quantityMatch ? "quantity_change" : "general_update", confidence: 0.7, evidence: [text.trim().slice(0, 300)] });
  return commitment.success ? commitment.data : null;
}
export type ApiEvent = Event;
