import { connectorRoutes, type Connectors } from "./connectors/routes";
import { supplierForSender } from "./connectors/identity";
import { communicationContext } from "./connectors/context";
import { Hono } from "hono";
import type { Context } from "hono";
import type { Event } from "../../../packages/domain/src/events";
import { normalizeCsv, normalizePoReference, validateSourceProvenance, isRemoteChannelSource, isSourceType, documentSourceTypeForMime, type PurchaseOrderReference } from "../../../packages/ingestion/src";
import { analysisCacheKey, MemoryAnalysisCache, runCachedAnalysis, type AnalysisRun, type DurableAnalysisCache } from "../../../packages/analysis-cache/src";
import { type ExtractionAdapter, structuredExtractionAdapter } from "../../../packages/ai/src/adapter";
import { SupplierCommitmentSchema, type SupplierCommitment } from "../../../packages/ai/src/schema";
import { PoContextArraySchema, operationalPoContextRecord, type PoContextRecord } from "../../../packages/ai/src/context";
import { EventProposalSchema, type EventProposal } from "../../../packages/ai/src/schema";
import { proposeSupplierCommitment } from "../../../packages/ai/src/adapter";
import { createConfiguredAIProvider, type ConfiguredAIProvider } from "../../../packages/ai/src/configured-provider";
import { createPaddleOcrAdapter, type OcrDocument } from "./paddleocr";
import { purchaseOrderRevision, DEFAULT_ORG, SourceRecordConflictError, SupplierConflictError, type MatchMethod, type MemoryStore, type PostgresStore } from "./store";
import type { PurchaseOrderRepository } from "./repositories/types";
import { ApprovalRequestSchema, CsvAnalysisRequestSchema, DocumentBindRequestSchema, ImportRequestSchema, MessageCreateSchema, MessageLinkSchema, ProposalApproveSchema, ProposalEditSchema, ProposalRejectSchema, SupplierCreateSchema, SupplierTextRequestSchema } from "./requests";

const MAX_BODY = 5 * 1024 * 1024;
type ApiStore = MemoryStore | PostgresStore;
/** Routes program against this seam; MemoryStore and PostgresStore both satisfy it. */
type StoreSeam = ApiStore & PurchaseOrderRepository;
export interface VisionAdapter {
  extract(image: Uint8Array, mimeType: string): Promise<{ output: unknown; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }>;
}
export interface OcrAdapter { extract(image: Uint8Array, mimeType: string): Promise<string | OcrDocument> }
import type { PurchasingAgent } from "./agent/runtime";

interface AppOptions { connectors?: Connectors; agent?: PurchasingAgent; cache?: MemoryAnalysisCache<unknown>; durableCache?: DurableAnalysisCache<unknown>; extractionAdapter?: ExtractionAdapter; visionAdapter?: VisionAdapter; ocrAdapter?: OcrAdapter; configuredProvider?: ConfiguredAIProvider; storageMode?: "memory" | "postgres" }

export function createApp(store: StoreSeam = new (requireMemoryStore())(), options: AppOptions = {}) {
  const app = new Hono();
  app.onError((error, c) => error instanceof SourceRecordConflictError
    ? c.json({ error: error.message, sourceRecordId: error.sourceRecordId }, 409)
    : c.json({ error: "The request could not be completed" }, 500));
  const cache = options.cache ?? new MemoryAnalysisCache<unknown>();
  const durable = options.durableCache;
  const documentOcr = options.ocrAdapter ?? createPaddleOcrAdapter();
  // Keep provider response metadata request-scoped; configured adapters retain their last response.
  const getConfiguredProvider = () => options.configuredProvider ?? createConfiguredAIProvider(process.env);
  const memoryStore = store instanceof (requireMemoryStore());
  const asyncCall = async <T>(fn: () => T | Promise<T>) => await fn();
  connectorRoutes(app, store, options.connectors, requestOrg);
  app.get("/api/health", (c) => c.json({ ok: true, storage: options.storageMode ?? (memoryStore ? "memory" : "postgres") }));
  app.get("/api/purchase-orders", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const orders = await asyncCall(() => store.purchaseOrders(org));
    return c.json(await Promise.all(orders.map(async (order) => ({
      ...order,
      poReference: (await asyncCall(() => store.purchaseOrderReference(order.entityId, org)))?.poNumber ?? order.entityId,
    }))));
  });
  app.get("/api/suppliers", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    return c.json(await asyncCall(() => store.suppliers(org)));
  });
  app.post("/api/suppliers", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBody = SupplierCreateSchema.safeParse(input);
    if (!parsedBody.success) return c.json({ error: "Invalid supplier request" }, 400);
    try {
      const supplier = await asyncCall(() => store.createSupplier(parsedBody.data, org));
      return c.json(supplier, 201);
    } catch (error) {
      if (error instanceof SupplierConflictError) return c.json({ error: error.message, supplierCode: error.supplierCode }, 409);
      throw error;
    }
  });
  app.get("/api/suppliers/:id", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const supplier = await asyncCall(() => store.supplier(c.req.param("id"), org));
    return supplier ? c.json(supplier) : c.json({ error: "Supplier not found" }, 404);
  });
  app.get("/api/suppliers/:id/purchase-orders", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const supplier = await asyncCall(() => store.supplier(c.req.param("id"), org));
    if (!supplier) return c.json({ error: "Supplier not found" }, 404);
    const orders = await asyncCall(() => store.supplierPurchaseOrders(supplier.id, org));
    const referenceById = new Map((await asyncCall(() => store.purchaseOrderReferences(org))).map((reference) => [reference.entityId, reference.poNumber]));
    return c.json(orders.map((order) => ({ ...order, poReference: referenceById.get(order.entityId) ?? order.entityId })));
  });
  app.post("/api/messages", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBody = MessageCreateSchema.safeParse(input);
    if (!parsedBody.success) return c.json({ error: "Invalid supplier message" }, 400);
    const body = parsedBody.data;
    const receivedAt = body.receivedAt ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(receivedAt))) return c.json({ error: "Invalid receivedAt" }, 400);
    if (body.sentAt !== undefined && !Number.isFinite(Date.parse(body.sentAt))) return c.json({ error: "Invalid sentAt" }, 400);
    // Remote channels must identify their sender; the channel message id falls
    // back to a manual content hash so pasted/manual messages stay idempotent
    // without inventing fake external ids.
    const provenanceErrors = validateSourceProvenance(body.channel, {
      sender: body.sender,
      channelMessageId: body.externalMessageId ?? "manual",
      receivedAt,
    });
    if (provenanceErrors.length > 0) return c.json({ error: provenanceErrors.join("; ") }, 400);
    const created = await asyncCall(() => store.createMessage({
      channel: body.channel,
      sender: body.sender,
      recipients: body.recipients,
      subject: body.subject,
      text: body.text,
      sentAt: body.sentAt,
      receivedAt,
      externalMessageId: body.externalMessageId,
      threadId: body.threadId,
    }, org));
    return c.json({ message: created.message, created: created.status === "created" }, created.status === "created" ? 201 : 200);
  });
  app.get("/api/messages", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    return c.json(await asyncCall(() => store.listMessages(org)));
  });
  app.get("/api/messages/:id", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const message = await asyncCall(() => store.getMessage(c.req.param("id"), org));
    if (!message) return c.json({ error: "Supplier message not found" }, 404);
    const candidates = await asyncCall(() => store.getMessageCandidates(message.id));
    const proposalRun = message.proposalRunKey
      ? (durable ? await durable.get(message.proposalRunKey) : (cache as MemoryAnalysisCache<unknown>).get(message.proposalRunKey)) ?? null
      : null;
    return c.json({ message, candidates, proposal: proposalRun?.result ?? null });
  });
  app.post("/api/messages/:id/link-purchase-order", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBody = MessageLinkSchema.safeParse(input);
    if (!parsedBody.success) return c.json({ error: "Invalid link request" }, 400);
    const message = await asyncCall(() => store.getMessage(c.req.param("id"), org));
    if (!message) return c.json({ error: "Supplier message not found" }, 404);
    const reference = await asyncCall(() => store.purchaseOrderReference(parsedBody.data.entityId, org));
    if (!reference) return c.json({ error: "Selected purchase order was not found" }, 404);
    if (["PROPOSAL_CREATED", "PROCESSED", "ANALYZING"].includes(message.processingStatus)) return c.json({ error: "This message is already being analyzed or has a saved analysis" }, 409);
    const activeWork = options.agent ? await options.agent.repository.hasActiveMessage(org, message.id) : null;
    if (activeWork) return c.json({ error: "Wait for the queued analysis to finish before changing its order match" }, 409);
    const candidates = await asyncCall(() => store.saveMessageCandidates(message.id, [{ entityId: reference.entityId, matchMethod: "USER_SELECTED" }], reference.entityId));
    const updated = await asyncCall(() => store.setMessageStatus(message.id, "MATCHING"));
    return c.json({ message: updated, candidates });
  });
  app.get("/api/agent", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    if (!options.agent) return c.json({ error: "Agent runtime unavailable" }, 503);
    if (org !== options.agent.organizationId) return c.json({ error: "Agent not configured for this workspace" }, 403);
    return c.json({ configuration: options.agent.configuration(), work: await options.agent.repository.list(org) });
  });
  app.post("/api/agent/emails/:id/retry", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    if (!options.agent || org !== options.agent.organizationId) return c.json({ error: "Agent not configured for this workspace" }, 403);
    const work = await options.agent.repository.retryEmail(c.req.param("id"), org);
    return work ? c.json({ work }, 202) : c.json({ error: "No failed email found" }, 409);
  });
  app.post("/api/messages/:id/queue", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    if (!options.agent) return c.json({ error: "Agent runtime unavailable" }, 503);
    if (org !== options.agent.organizationId) return c.json({ error: "Agent not configured for this workspace" }, 403);
    const message = await asyncCall(() => store.getMessage(c.req.param("id"), org));
    if (!message) return c.json({ error: "Supplier message not found" }, 404);
    return c.json({ job: await options.agent.enqueue(message.id, org) }, 202);
  });
  app.post("/api/messages/:id/process", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    if (options.agent) {
      if (org !== options.agent.organizationId) return c.json({ error: "Agent not configured for this workspace" }, 403);
      if (!await asyncCall(() => store.getMessage(c.req.param("id"), org))) return c.json({ error: "Supplier message not found" }, 404);
      return c.json({ job: await options.agent.enqueue(c.req.param("id"), org), status: "QUEUED" }, 202);
    }
    const configured = getConfiguredProvider();
    if (!configured.configured && !options.extractionAdapter) return c.json({ error: "AI provider is not configured", configurationError: configured.configurationError }, 503);
    const adapter = options.extractionAdapter ?? configured.extractionAdapter;
    if (!adapter) return c.json({ error: "No extraction provider configured" }, 503);
    const processed = await processMessage(c.req.param("id"), org, adapter, configured);
    if (!processed) return c.json({ error: "Supplier message not found" }, 404);
    return c.json(processed);
  });

  /**
   * Deterministic message processing: match first, model only when a single
   * PO candidate survives. Repeat calls are idempotent via stored status and
   * the versioned analysis cache (no second model call for the same input).
   */
  const processMessage = async (messageId: string, org: string, adapter: ExtractionAdapter, configured: ConfiguredAIProvider) => {
    const message = await asyncCall(() => store.getMessage(messageId, org));
    if (!message) return null;
    if (message.processingStatus === "PROPOSAL_CREATED" || message.processingStatus === "PROCESSED") {
      const candidates = await asyncCall(() => store.getMessageCandidates(messageId));
      return { message, candidates, proposal: null, runKey: message.proposalRunKey, status: message.processingStatus };
    }
    await asyncCall(() => store.setMessageStatus(messageId, "MATCHING"));
    const refs = await asyncCall(() => store.purchaseOrderReferences(org));
    const stored = await asyncCall(() => store.getMessageCandidates(messageId));
    const userSelected = stored.find((candidate) => candidate.isSelected);
    const suppliers = await asyncCall(() => store.suppliers(org));
    const supplier = supplierForSender(suppliers, message.sender, message.channel);
    if (supplier && !message.supplierId) {
      await asyncCall(() => store.setMessageStatus(messageId, "MATCHING", { supplierId: supplier.id }));
    }
    const supplierOpen = supplier && !userSelected
      ? (await asyncCall(() => store.supplierPurchaseOrders(supplier.id, org))).filter((po) => po.status !== "RECEIVED")
      : [];
    const openIds = new Set(supplierOpen.map((po) => po.entityId));
    const matchingText = `${message.subject ?? ""}\n${message.text}`;
    const exact = userSelected ? [] : findPoCandidates(matchingText, refs);
    const threadOrders = new Set<string>();
    if (supplier && message.threadId) {
      for (const previous of await store.listMessages(org)) {
        if (previous.id === message.id || previous.threadId !== message.threadId || supplierForSender(suppliers, previous.sender, previous.channel)?.id !== supplier.id) continue;
        for (const candidate of await store.getMessageCandidates(previous.id)) if (candidate.isSelected && openIds.has(candidate.entityId)) threadOrders.add(candidate.entityId);
        for (const candidate of findPoCandidates(`${previous.subject ?? ""}\n${previous.text}`, refs)) if (openIds.has(candidate.entityId)) threadOrders.add(candidate.entityId);
      }
    }
    const asExact = (entityIds: readonly string[]): Array<{ entityId: string; matchMethod: MatchMethod }> =>
      entityIds.map((entityId) => ({ entityId, matchMethod: "EXACT_PO_REFERENCE" as const }));
    let candidates: Array<{ entityId: string; matchMethod: MatchMethod }>;
    let selected: { entityId: string; matchMethod: MatchMethod } | undefined;
    const hasExplicitReference = /\bPO[- #]?[A-Z0-9][A-Z0-9-]*\b/i.test(matchingText);
    if (!userSelected && supplier && exact.length === 1 && !openIds.has(exact[0]!.entityId)) {
      // A known sender naming another supplier's order must not override supplier ownership.
      candidates = asExact(exact.map(candidate => candidate.entityId));
    } else if (userSelected) {
      candidates = [{ entityId: userSelected.entityId, matchMethod: "USER_SELECTED" }];
      selected = candidates[0];
    } else if (exact.length === 1) {
      candidates = asExact(exact.map((candidate) => candidate.entityId));
      selected = candidates[0];
    } else if (exact.length > 1 && supplier) {
      const narrowed = exact.filter((candidate) => openIds.has(candidate.entityId));
      if (narrowed.length === 1) {
        candidates = asExact(narrowed.map((candidate) => candidate.entityId));
        selected = candidates[0];
      } else {
        candidates = asExact((narrowed.length > 0 ? narrowed : exact).map((candidate) => candidate.entityId));
      }
    } else if (exact.length === 0 && !hasExplicitReference && threadOrders.size === 1) {
      candidates = [{ entityId: [...threadOrders][0]!, matchMethod: "THREAD_HISTORY" }];
      selected = candidates[0];
    } else if (exact.length === 0 && !hasExplicitReference && supplierOpen.length === 1 && supplierOpen[0]) {
      candidates = [{ entityId: supplierOpen[0].entityId, matchMethod: "SUPPLIER_OPEN_PO" }];
      selected = candidates[0];
    } else if (exact.length === 0 && !hasExplicitReference && supplierOpen.length > 1) {
      candidates = supplierOpen.map((po) => ({ entityId: po.entityId, matchMethod: "SUPPLIER_OPEN_PO" as const }));
    } else if (exact.length > 1) {
      candidates = asExact(exact.map((candidate) => candidate.entityId));
    } else {
      candidates = [];
    }
    const saved = await asyncCall(() => store.saveMessageCandidates(messageId, candidates, selected?.entityId));
    const review = async () => {
      const updated = await asyncCall(() => store.setMessageStatus(messageId, "REVIEW_REQUIRED"));
      return { message: updated, candidates: saved, proposal: null, runKey: null, status: "REVIEW_REQUIRED" as const };
    };
    if (!selected) return review();
    const selectedOrder = await asyncCall(() => store.state(selected.entityId));
    const selectedReference = await asyncCall(() => store.purchaseOrderReference(selected.entityId, org));
    if (!selectedOrder || !selectedReference) return review();
    await asyncCall(() => store.setMessageStatus(messageId, "ANALYZING"));
    const { model, provider } = configured;
    const poContext = [operationalPoContextRecord({
      poId: selectedReference.poNumber,
      supplierId: selectedOrder.supplierId,
      supplierName: selectedOrder.supplierName,
      quantity: selectedOrder.confirmedQuantity ?? selectedOrder.orderedQuantity ?? selectedOrder.reducedQuantity,
      plannedDeliveryDate: selectedOrder.eta,
      orderStatus: selectedOrder.status,
    })];
    const matchContext = { sourceRecordId: message.sourceRecordId, entityId: selected.entityId, matchingPoCount: 1 };
    const historyContext = await communicationContext(store, message, supplier, selected.entityId, selectedReference.poNumber);
    const analysisContext = {
      ...matchContext,
      communicationContext: historyContext,
      poReference: selectedReference.poNumber,
      baselineEta: selectedOrder.eta,
      baselineQuantity: selectedOrder.confirmedQuantity ?? selectedOrder.orderedQuantity ?? selectedOrder.reducedQuantity ?? null,
      baselineRevision: purchaseOrderRevision(selectedOrder),
      messageId,
      sourceType: message.channel,
      organizationId: org,
    };
    const request = {
      input: JSON.stringify({ message: message.text, context: analysisContext, poContext, communicationContext: historyContext }),
      mediaType: "text" as const,
      analysisType: "supplier_commitment_extraction",
      model,
      provider,
      promptVersion: `${process.env.AI_PROMPT_VERSION ?? "supplier-v2"}/communication-v1`,
      schemaVersion: process.env.AI_SCHEMA_VERSION ?? "commitment-v1",
      context: analysisContext,
    };
    try {
      const got = await runCachedAnalysis(request, cache as MemoryAnalysisCache<EventProposal>, { run: async () => {
        const proposal = await proposeSupplierCommitment(message.text, matchContext, adapter, { poContext, communicationContext: historyContext });
        // Transient provider failures must be cached as failed runs so worker retries call the provider again.
        if (proposal.reason === "Extraction adapter failed") throw new Error("Supplier extraction request failed");
        const metadata = options.extractionAdapter ? undefined : configured.extractionAdapter?.lastResponse;
        const usage = metadata?.usage ? numericUsage(metadata.usage) : undefined;
        return {
          result: proposal,
          status: proposal.state === "VALID" ? "completed" as const : "needs_review" as const,
          usage,
          modelRequest: { provider, model, mediaType: "text", messageId },
          modelResponse: metadata?.response ?? undefined,
        };
      } }, { durable: durable as DurableAnalysisCache<EventProposal> | undefined, retryFailed: true });
      if (got.run.status === "failed") throw new Error("Supplier extraction failed");
      const updated = await asyncCall(() => store.setMessageStatus(messageId, "PROPOSAL_CREATED", {
        supplierId: supplier?.id ?? message.supplierId,
        proposalRunKey: got.run.cacheKey,
      }));
      await ensureProposalForRun(got.run, org, messageId);
      return { message: updated, candidates: saved, proposal: got.run.result, runKey: got.run.cacheKey, status: "PROPOSAL_CREATED" as const };
    } catch {
      const updated = await asyncCall(() => store.setMessageStatus(messageId, "FAILED"));
      return { message: updated, candidates: saved, proposal: null, runKey: null, status: "FAILED" as const };
    }
  };
  app.get("/api/purchase-orders/:id", async (c) => { const state = await asyncCall(() => store.state(c.req.param("id"))); return state ? c.json(state) : c.json({ error: "Purchase order not found" }, 404); });
  app.get("/api/purchase-orders/:id/timeline", async (c) => c.json(await asyncCall(() => store.timeline(c.req.param("id")))));
  app.get("/api/exceptions", async (c) => c.json(await asyncCall(() => store.exceptions())));

  const importHandler = async (c: Context, sourceType: string) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const contentType = c.req.header("content-type") ?? "";
    const explicitId = c.req.header("idempotency-key") ?? c.req.header("x-source-record-id");
    const length = Number(c.req.header("content-length") ?? 0);
    if (length > MAX_BODY) return c.json({ error: "Request body too large" }, 413);
    if (contentType.includes("text/csv")) {
      const raw = await readLimited(c.req.raw);
      if (raw === null) return c.json({ error: "Request body too large" }, 413);
      const csv = new TextDecoder().decode(raw);
      const id = explicitId ?? `source-${sha256(`${sourceType}\n${csv}`)}`;
      return c.json(await store.importCsv(csv, id, sourceType, org));
    }
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBody = ImportRequestSchema.safeParse(input);
    if (!parsedBody.success) return c.json({ error: "Invalid import request" }, 400);
    const body = parsedBody.data;
    if (body.csv) return c.json(await store.importCsv(body.csv, body.sourceRecordId ?? explicitId ?? `source-${sha256(`${sourceType}\n${body.csv}`)}`, sourceType, org));
    if (body.rows) return c.json(await store.importRows(body.rows, body.sourceRecordId ?? explicitId ?? `source-${sha256(`${sourceType}\n${JSON.stringify(body.rows)}`)}`, sourceType, org));
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
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBody = CsvAnalysisRequestSchema.safeParse(input);
    if (!parsedBody.success) return c.json({ error: "Invalid CSV analysis request" }, 400);
    const body = parsedBody.data;
    if (new TextEncoder().encode(body.csv).byteLength > MAX_BODY) return c.json({ error: "Request body too large" }, 413);
    const id = body.sourceRecordId ?? "analysis-csv";
    const refs = body.purchaseOrders ?? [];
    const request = { input: body.csv, mediaType: "csv" as const, analysisType: "deterministic_csv_normalization", model: "none", provider: "deterministic", promptVersion: "csv-v1", schemaVersion: "events-v1", context: { id, refs } };
    const result = await runCachedAnalysis(request, cache as MemoryAnalysisCache<NormalizationResult>, { run: async () => ({ result: normalizeCsv(body.csv!, id, refs) }) }, { durable: durable as DurableAnalysisCache<NormalizationResult> | undefined, retryFailed: body.retry });
    return c.json({ ...result, status: result.run.status, usage: result.run.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } });
  });

  app.post("/api/analysis/supplier-text", async (c) => {
    const raw = await readLimited(c.req.raw); if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let input: unknown;
    try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBody = SupplierTextRequestSchema.safeParse(input);
    if (!parsedBody.success) return c.json({ error: "Invalid supplier message request" }, 400);
    const body = parsedBody.data;
    const parsedPoContext = body.poContext === undefined ? { success: true as const, data: [] as const } : PoContextArraySchema.safeParse(body.poContext);
    if (!parsedPoContext.success) return c.json({ error: "Invalid poContext" }, 400);
    const callerPoContext = parsedPoContext.success ? [...parsedPoContext.data] : [];
    // Channel provenance: pasted notes need none, remote channels must identify sender/message/time.
    const sourceType = body.sourceType ?? "supplier_message";
    const provenanceErrors = validateSourceProvenance(sourceType, body.provenance);
    if (provenanceErrors.length > 0) return c.json({ error: provenanceErrors.join("; ") }, 400);
    const configuredProvider = getConfiguredProvider();
    const { model, provider } = configuredProvider;
    if (!configuredProvider.configured && !options.extractionAdapter) return c.json({ error: "AI provider is not configured", configurationError: configuredProvider.configurationError }, 503);
    let providerUsage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined;
    const adapter = options.extractionAdapter ?? configuredProvider.extractionAdapter;
    if (!adapter) return c.json({ error: "No extraction provider configured" }, 503);
    const sourceRecordId = body.sourceRecordId ?? `text-${sha256(body.text)}`;
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const entityId = typeof body.entityId === "string" && body.entityId.trim() ? body.entityId.trim() : null;
    const selectedOrder = entityId ? await asyncCall(() => store.state(entityId)) : undefined;
    const selectedReference = entityId ? await asyncCall(() => store.purchaseOrderReference(entityId, org)) : undefined;
    if (entityId && (!selectedOrder || !selectedReference)) return c.json({ error: "Selected purchase order was not found" }, 404);
    // The selected PO's live baseline is always given to the model as factual
    // <po_context>, so eta_change/quantity_change can be judged against current
    // state. Caller-supplied corpus records remain appended after it.
    const operationalBaseline: PoContextRecord[] = entityId && selectedOrder && selectedReference
      ? [operationalPoContextRecord({
        poId: selectedReference.poNumber,
        supplierId: selectedOrder.supplierId,
        supplierName: selectedOrder.supplierName,
        quantity: selectedOrder.confirmedQuantity ?? selectedOrder.orderedQuantity ?? selectedOrder.reducedQuantity,
        plannedDeliveryDate: selectedOrder.eta,
        orderStatus: selectedOrder.status,
      })]
      : [];
    const poContext = [...operationalBaseline, ...callerPoContext].slice(0, 50);
    // Deterministic PO discovery for pasted emails sent without a selection:
    // match PO-prefixed tokens (e.g. "PO-1001") against known references.
    // This never auto-selects; it only suggests candidates and informs review.
    const allReferences = await asyncCall(() => store.purchaseOrderReferences(org));
    const poCandidates = entityId ? [] : findPoCandidates(body.text, allReferences);
    const effectiveMatchingPoCount = entityId ? 1 : body.matchingPoCount ?? (poCandidates.length === 0 && !extractsPoToken(body.text) ? undefined : poCandidates.length);
    // Keep an absent PO selection distinct from an explicit null: free-text analysis
    // can still return a proposal, while the approval endpoint requires a selected PO.
    const context = { sourceRecordId, ...(entityId ? { entityId } : {}), ...(effectiveMatchingPoCount === undefined ? {} : { matchingPoCount: effectiveMatchingPoCount }) };
    const orderSnapshot = entityId ? { entityId, poReference: selectedReference!.poNumber, baselineEta: selectedOrder!.eta, baselineQuantity: selectedOrder!.confirmedQuantity ?? selectedOrder!.orderedQuantity ?? selectedOrder!.reducedQuantity ?? null, baselineRevision: purchaseOrderRevision(selectedOrder!) } : {};
    // sourceType/provenance join the persisted run context (and cache identity) so the
    // approval step records which channel the claim arrived on. The proposal context
    // above stays limited to review-routing fields.
    const requestContext = { ...context, ...orderSnapshot, sourceType, organizationId: org, ...(body.provenance === undefined ? {} : { provenance: body.provenance }) };
    const request = { input: poContext.length > 0 ? JSON.stringify({ message: body.text, context: requestContext, poContext }) : JSON.stringify({ message: body.text, context: requestContext }), mediaType: "text" as const, analysisType: "supplier_commitment_extraction", model, provider, promptVersion: process.env.AI_PROMPT_VERSION ?? "supplier-v2", schemaVersion: process.env.AI_SCHEMA_VERSION ?? "commitment-v1", context: requestContext };
    const failed = body.retry ? ((durable ? await durable.get(analysisCacheKey(request)) : cache.get(analysisCacheKey(request)))?.status === "failed") : false;
    const got = await runCachedAnalysis(request, cache as MemoryAnalysisCache<EventProposal>, { run: async () => {
      const proposal = await proposeSupplierCommitment(body.text!, context, adapter, { poContext });
      const metadata = options.extractionAdapter ? undefined : configuredProvider.extractionAdapter?.lastResponse;
      const usage = metadata?.usage ? numericUsage(metadata.usage) : providerUsage;
      return { result: proposal, usage, modelRequest: { provider, model, mediaType: "text" }, modelResponse: metadata?.response ?? undefined };
    } }, { durable: durable as DurableAnalysisCache<EventProposal> | undefined, retryFailed: failed });
    return c.json({ proposal: got.run.result, run: got.run, cacheHit: got.cacheHit, status: got.run.status, usage: got.cacheHit ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : got.run.usage ?? null, runUsage: got.run.usage ?? null, poCandidates, baseline: entityId ? { poReference: selectedReference!.poNumber, eta: selectedOrder!.eta } : null, changeProposal: await ensureProposalForRun(got.run, org) });
  });

  app.post("/api/analysis/runs/:key/approve", async (c) => {
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedApproval = ApprovalRequestSchema.safeParse(parsedBody);
    if (!parsedApproval.success) return c.json({ error: "Invalid approval request" }, 400);
    const etaInput = parsedApproval.data.eta;
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const run = durable
      ? await durable.get(c.req.param("key"))
      : (cache as MemoryAnalysisCache<unknown>).get(c.req.param("key"));
    if (!run) return c.json({ error: "Analysis run not found" }, 404);
    if (run.request.analysisType !== "supplier_commitment_extraction" || !["completed", "needs_review"].includes(run.status)) {
      return c.json({ error: "This analysis cannot be approved" }, 409);
    }
    // Compatibility shim: every bound run carries a first-class proposal row;
    // a REJECTED proposal stays rejected, everything else flows to the service.
    const ensured = await ensureProposalForRun(run, org);
    if (ensured && ensured.status === "REJECTED") {
      return c.json({ error: "This proposal was rejected", proposalId: ensured.id }, 409);
    }
    const outcome = await approveEtaRun(run, etaInput, org);
    if (ensured && (outcome.http === 201 || outcome.http === 200)) {
      await asyncCall(() => store.transitionProposal(ensured.id, org, outcome.edited ? "EDITED_AND_APPROVED" : "APPROVED"));
      await asyncCall(() => store.transitionProposal(ensured.id, org, "APPLIED"));
    } else if (ensured && outcome.http === 409) {
      await asyncCall(() => store.transitionProposal(ensured.id, org, "STALE"));
    }
    return c.json(outcome.body, outcome.http);
  });

  type ApprovalOutcome = { http: 200 | 201 | 400 | 404 | 409; body: unknown; edited: boolean };

  /** Shared ETA approval command (plan section 12): revision-checked, idempotent, tenant-scoped. */
  const approveEtaRun = async (run: AnalysisRun<unknown>, etaInput: string | undefined, org: string): Promise<ApprovalOutcome> => {
    const parsedProposal = EventProposalSchema.safeParse(run.result);
    if (!parsedProposal.success) return { http: 409, body: { error: "There is no valid supplier proposal to approve" }, edited: false };
    const proposal = parsedProposal.data;
    if (!proposal.commitment) return { http: 409, body: { error: "There is no extracted supplier update to approve" }, edited: false };
    const commitment = proposal.commitment;
    const context = run.request.context as Record<string, unknown> | undefined;
    const entityId = typeof context?.entityId === "string" ? context.entityId : null;
    const poReference = typeof context?.poReference === "string" ? context.poReference : null;
    const baselineEta = typeof context?.baselineEta === "string" ? context.baselineEta : null;
    const baselineRevision = typeof context?.baselineRevision === "string" ? context.baselineRevision : null;
    if (!entityId || !baselineRevision || proposal.entityId !== entityId || proposal.sourceRecordId !== context?.sourceRecordId) {
      return { http: 409, body: { error: "Select a purchase order and analyze the supplier message again before approving" }, edited: false };
    }
    if (["INVALID_SCHEMA", "UNKNOWN_PO", "AMBIGUOUS_PO", "DUPLICATE_SOURCE"].includes(proposal.state)) {
      return { http: 409, body: { error: "This proposal needs more information before it can be approved", state: proposal.state }, edited: false };
    }
    if (commitment.poReference && poReference && normalizePoReference(commitment.poReference) !== normalizePoReference(poReference)) {
      return { http: 409, body: { error: "The PO number in the message does not match the selected purchase order", extractedPoReference: commitment.poReference }, edited: false };
    }
    const eta = etaInput ?? commitment.eta;
    if (!eta || !/^\d{4}-\d{2}-\d{2}$/.test(eta) || !Number.isFinite(Date.parse(`${eta}T00:00:00Z`)) || new Date(`${eta}T00:00:00Z`).toISOString().slice(0, 10) !== eta) {
      return { http: 400, body: { error: "A valid revised delivery date is required" }, edited: false };
    }
    const current = await asyncCall(() => store.state(entityId));
    const reference = await asyncCall(() => store.purchaseOrderReference(entityId, org));
    if (!current || !reference) return { http: 404, body: { error: "Selected purchase order was not found" }, edited: false };
    const result = await asyncCall(() => store.applyApprovedEtaChange({
      entityId,
      expectedEta: baselineEta,
      expectedRevision: baselineRevision,
      approvalId: run.cacheKey,
      eta,
      approvedAt: new Date().toISOString(),
      sourceRecordId: proposal.sourceRecordId,
      sourceText: proposal.sourceText,
      sourceType: typeof context?.sourceType === "string" && isSourceType(context.sourceType) ? context.sourceType : "supplier_message",
      organizationId: org,
    }));
    if (result.status === "unknown_po") return { http: 404, body: { error: "Selected purchase order was not found" }, edited: false };
    if (result.status === "stale") return { http: 409, body: { error: "The order changed before approval. Analyze the message again.", currentEta: result.currentEta }, edited: false };
    if (result.status === "unchanged") return { http: 409, body: { error: "The proposed date is already on this order" }, edited: false };
    const state = await asyncCall(() => store.state(entityId));
    return { http: result.status === "applied" ? 201 : 200, body: { status: result.status, event: result.event, purchaseOrder: state }, edited: etaInput !== undefined && etaInput !== commitment.eta };
  };

  /** Quantity approval command: same guards as ETA, writing quantity events. */
  const approveQuantityRun = async (run: AnalysisRun<unknown>, quantityInput: number | undefined, org: string): Promise<ApprovalOutcome> => {
    const parsedProposal = EventProposalSchema.safeParse(run.result);
    if (!parsedProposal.success) return { http: 409, body: { error: "There is no valid supplier proposal to approve" }, edited: false };
    const proposal = parsedProposal.data;
    if (!proposal.commitment) return { http: 409, body: { error: "There is no extracted supplier update to approve" }, edited: false };
    const commitment = proposal.commitment;
    const context = run.request.context as Record<string, unknown> | undefined;
    const entityId = typeof context?.entityId === "string" ? context.entityId : null;
    const poReference = typeof context?.poReference === "string" ? context.poReference : null;
    const baselineRevision = typeof context?.baselineRevision === "string" ? context.baselineRevision : null;
    const baselineQuantity = typeof context?.baselineQuantity === "number" ? context.baselineQuantity
      : context?.baselineQuantity === null ? null : undefined;
    if (!entityId || !baselineRevision || proposal.entityId !== entityId || proposal.sourceRecordId !== context?.sourceRecordId) {
      return { http: 409, body: { error: "Select a purchase order and analyze the supplier message again before approving" }, edited: false };
    }
    if (["INVALID_SCHEMA", "UNKNOWN_PO", "AMBIGUOUS_PO", "DUPLICATE_SOURCE"].includes(proposal.state)) {
      return { http: 409, body: { error: "This proposal needs more information before it can be approved", state: proposal.state }, edited: false };
    }
    if (commitment.poReference && poReference && normalizePoReference(commitment.poReference) !== normalizePoReference(poReference)) {
      return { http: 409, body: { error: "The PO number in the message does not match the selected purchase order", extractedPoReference: commitment.poReference }, edited: false };
    }
    const quantity = quantityInput ?? commitment.quantity;
    if (typeof quantity !== "number" || !Number.isFinite(quantity) || quantity < 0) {
      return { http: 400, body: { error: "A valid revised quantity is required" }, edited: false };
    }
    const current = await asyncCall(() => store.state(entityId));
    const reference = await asyncCall(() => store.purchaseOrderReference(entityId, org));
    if (!current || !reference) return { http: 404, body: { error: "Selected purchase order was not found" }, edited: false };
    const result = await asyncCall(() => store.applyApprovedQuantityChange({
      entityId,
      expectedQuantity: baselineQuantity ?? current.confirmedQuantity ?? current.orderedQuantity,
      expectedRevision: baselineRevision,
      approvalId: run.cacheKey,
      quantity,
      approvedAt: new Date().toISOString(),
      sourceRecordId: proposal.sourceRecordId,
      sourceText: proposal.sourceText,
      sourceType: typeof context?.sourceType === "string" && isSourceType(context.sourceType) ? context.sourceType : "supplier_message",
      organizationId: org,
    }));
    if (result.status === "unknown_po") return { http: 404, body: { error: "Selected purchase order was not found" }, edited: false };
    if (result.status === "stale") return { http: 409, body: { error: "The order changed before approval. Analyze the message again.", currentEta: result.currentEta }, edited: false };
    if (result.status === "unchanged") return { http: 409, body: { error: "The proposed quantity is already on this order" }, edited: false };
    const state = await asyncCall(() => store.state(entityId));
    return { http: result.status === "applied" ? 201 : 200, body: { status: result.status, event: result.event, purchaseOrder: state }, edited: quantityInput !== undefined && quantityInput !== commitment.quantity };
  };

  /** Persists the first-class proposal row for a bound analysis run; null when the run carries nothing approvable. */
  const ensureProposalForRun = async (run: AnalysisRun<unknown>, org: string, messageId?: string) => {
    const parsed = EventProposalSchema.safeParse(run.result);
    const commitment = parsed.success ? parsed.data.commitment : null;
    if (!parsed.success || !commitment) return null;
    const proposal = parsed.data;
    const context = (run.request.context ?? {}) as Record<string, unknown>;
    const entityId = typeof context.entityId === "string" ? context.entityId : proposal.entityId;
    const baselineRevision = typeof context.baselineRevision === "string" ? context.baselineRevision : null;
    if (!entityId || !baselineRevision || proposal.entityId !== entityId) return null;
    const etaChanged = commitment.eta !== null && commitment.eta !== undefined && commitment.eta !== context.baselineEta;
    const quantityChanged = commitment.quantity !== null && commitment.quantity !== undefined && commitment.quantity !== context.baselineQuantity;
    // The persisted proposal currently supports one field. Never silently discard a second changed field.
    if (etaChanged && quantityChanged) return null;
    const proposalType = etaChanged ? "ETA_CHANGE" as const : quantityChanged ? "QUANTITY_CHANGE" as const : null;
    if (!proposalType) return null;
    const sourceType = typeof context.sourceType === "string" && isSourceType(context.sourceType) ? context.sourceType : "supplier_message";
    const created = await asyncCall(() => store.ensureProposal({
      analysisRunKey: run.cacheKey,
      messageId: messageId ?? (typeof context.messageId === "string" ? context.messageId : null),
      entityId,
      proposalType,
      payload: proposalType === "ETA_CHANGE" ? { eta: commitment.eta } : { quantity: commitment.quantity },
      evidence: { evidence: commitment.evidence, sourceRecordId: proposal.sourceRecordId },
      reviewState: proposal.state,
      baselineRevision,
      organizationId: org,
      sourceRecordId: proposal.sourceRecordId,
      sourceType,
    }));
    if (created.status === "created" && messageId && proposal.state === "VALID") {
      const currentMessage = await store.getMessage(messageId, org);
      if (currentMessage) for (const older of await store.listProposals(org)) {
        if (older.id === created.proposal.id || older.status !== "PENDING" || older.entityId !== entityId || older.proposalType !== proposalType || !older.messageId) continue;
        const original = await store.getMessage(older.messageId, org);
        if (original && Date.parse(original.sentAt ?? original.receivedAt) < Date.parse(currentMessage.sentAt ?? currentMessage.receivedAt)) {
          await store.transitionProposal(older.id, org, "STALE", { reviewedNote: "A newer supplier message proposed a change to the same field." });
        }
      }
    }
    return created.proposal;
  };

  app.get("/api/proposals", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    return c.json(await asyncCall(() => store.listProposals(org)));
  });
  app.get("/api/proposals/:id", async (c) => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const proposal = await asyncCall(() => store.getProposal(c.req.param("id"), org));
    if (!proposal) return c.json({ error: "Proposal not found" }, 404);
    const run = durable ? await durable.get(proposal.analysisRunKey) : (cache as MemoryAnalysisCache<unknown>).get(proposal.analysisRunKey);
    return c.json({ proposal, run: run ?? null });
  });
  const proposalAction = async (c: Context, mode: "approve" | "approve-with-edit" | "reject") => {
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let input: unknown = {};
    if (raw.length > 0) {
      try { input = JSON.parse(new TextDecoder().decode(raw)); }
      catch { return c.json({ error: "Invalid JSON body" }, 400); }
    }
    const proposalId = c.req.param("id");
    if (!proposalId) return c.json({ error: "Proposal not found" }, 404);
    const proposal = await asyncCall(() => store.getProposal(proposalId, org));
    if (!proposal) return c.json({ error: "Proposal not found" }, 404);
    if (mode === "reject") {
      const parsed = ProposalRejectSchema.safeParse(input);
      if (!parsed.success) return c.json({ error: "Invalid reject request" }, 400);
      if (proposal.status === "REJECTED") return c.json({ proposal, status: proposal.status }, 200);
      if (proposal.status !== "PENDING") return c.json({ error: `Proposal is ${proposal.status.toLowerCase()} and cannot be rejected`, status: proposal.status }, 409);
      const transitioned = await asyncCall(() => store.transitionProposal(proposal.id, org, "REJECTED", { reviewedNote: parsed.data.reason }));
      return c.json({ proposal: transitioned.proposal, status: "REJECTED" }, 200);
    }
    const parsed = (mode === "approve-with-edit" ? ProposalEditSchema : ProposalApproveSchema).safeParse(input);
    if (!parsed.success) return c.json({ error: "Invalid approval request" }, 400);
    if (proposal.status === "REJECTED" || proposal.status === "STALE") {
      return c.json({ error: `Proposal is ${proposal.status.toLowerCase()} and cannot be approved`, status: proposal.status }, 409);
    }
    const run = durable ? await durable.get(proposal.analysisRunKey) : (cache as MemoryAnalysisCache<unknown>).get(proposal.analysisRunKey);
    if (!run) return c.json({ error: "Linked analysis run was not found" }, 404);
    const outcome = proposal.proposalType === "QUANTITY_CHANGE"
      ? await approveQuantityRun(run, parsed.data.quantity, org)
      : await approveEtaRun(run, parsed.data.eta, org);
    if (outcome.http === 201 || outcome.http === 200) {
      await asyncCall(() => store.transitionProposal(proposal.id, org, outcome.edited ? "EDITED_AND_APPROVED" : "APPROVED"));
      const applied = await asyncCall(() => store.transitionProposal(proposal.id, org, "APPLIED"));
      return c.json({ ...outcome.body as Record<string, unknown>, proposal: applied.proposal }, outcome.http);
    }
    if (outcome.http === 409) {
      await asyncCall(() => store.transitionProposal(proposal.id, org, "STALE"));
    }
    return c.json(outcome.body, outcome.http);
  };
  app.post("/api/proposals/:id/approve", (c) => proposalAction(c, "approve"));
  app.post("/api/proposals/:id/approve-with-edit", (c) => proposalAction(c, "approve-with-edit"));
  app.post("/api/proposals/:id/reject", (c) => proposalAction(c, "reject"));

  app.post("/api/analysis/runs/:key/bind", async (c) => {
    const raw = await readLimited(c.req.raw);
    if (raw === null) return c.json({ error: "Request body too large" }, 413);
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(new TextDecoder().decode(raw)); }
    catch { return c.json({ error: "Invalid JSON body" }, 400); }
    const parsedBind = DocumentBindRequestSchema.safeParse(parsedBody);
    if (!parsedBind.success) return c.json({ error: "Invalid bind request" }, 400);
    const docKey = c.req.param("key");
    const docRun = durable
      ? await durable.get(docKey)
      : (cache as MemoryAnalysisCache<unknown>).get(docKey);
    if (!docRun) return c.json({ error: "Analysis run not found" }, 404);
    if (docRun.request.analysisType !== "supplier_image" && docRun.request.analysisType !== "supplier_pdf") {
      return c.json({ error: "Only document analyses can be bound to a purchase order" }, 409);
    }
    const claim = docClaim(docRun);
    if (!claim) return c.json({ error: "This document has no extracted update to bind" }, 409);
    if (!claim.ocrText.trim()) return c.json({ error: "This document has no usable text to bind" }, 409);
    const docContext = docRun.request.context as Record<string, unknown> | undefined;
    const docSourceRecordId = typeof docContext?.sourceRecordId === "string" ? docContext.sourceRecordId : null;
    if (!docSourceRecordId) return c.json({ error: "This document run has no source record" }, 409);
    const mime = typeof docContext?.mime === "string"
      ? docContext.mime
      : docRun.request.analysisType === "supplier_pdf" ? "application/pdf" : "image/png";
    const entityId = parsedBind.data.entityId;
    const org = requestOrg(c);
    if (!org) return c.json({ error: "Invalid x-organization-id" }, 400);
    const selectedOrder = await asyncCall(() => store.state(entityId));
    const selectedReference = await asyncCall(() => store.purchaseOrderReference(entityId, org));
    if (!selectedOrder || !selectedReference) return c.json({ error: "Selected purchase order was not found" }, 404);
    // Deterministic bind: no model call. The stored document commitment is
    // re-proposed against the selected PO's live baseline through the same
    // review-state logic as pasted text, then approved via the shared endpoint.
    const baseline = operationalPoContextRecord({
      poId: selectedReference.poNumber,
      supplierId: selectedOrder.supplierId,
      supplierName: selectedOrder.supplierName,
      quantity: selectedOrder.confirmedQuantity ?? selectedOrder.orderedQuantity ?? selectedOrder.reducedQuantity,
      plannedDeliveryDate: selectedOrder.eta,
      orderStatus: selectedOrder.status,
    });
    const poContext = [baseline];
    const sourceType = documentSourceTypeForMime(mime);
    const bindContext = {
      sourceRecordId: docSourceRecordId,
      entityId,
      matchingPoCount: 1,
      poReference: selectedReference.poNumber,
      baselineEta: selectedOrder.eta,
      baselineQuantity: selectedOrder.confirmedQuantity ?? selectedOrder.orderedQuantity ?? selectedOrder.reducedQuantity ?? null,
      baselineRevision: purchaseOrderRevision(selectedOrder),
      boundFrom: docKey,
      sourceType,
      organizationId: org,
    };
    const proposal = await proposeSupplierCommitment(
      claim.ocrText,
      { sourceRecordId: docSourceRecordId, entityId, matchingPoCount: 1 },
      structuredExtractionAdapter(claim.commitment),
      { poContext },
    );
    const bindRequest = {
      input: JSON.stringify({ ocrText: claim.ocrText, context: bindContext, poContext }),
      mediaType: "text" as const,
      analysisType: "supplier_commitment_extraction",
      model: "none",
      provider: "deterministic",
      promptVersion: "bind-v1",
      schemaVersion: "commitment-v1",
      context: bindContext,
    };
    const bound = await runCachedAnalysis(bindRequest, cache as MemoryAnalysisCache<EventProposal>, { run: async () => ({
      result: proposal,
      status: proposal.state === "VALID" ? "completed" as const : "needs_review" as const,
      modelRequest: { provider: "deterministic", bindFrom: docKey, ocrText: claim.ocrText },
      modelResponse: { bound: true },
    }) }, { durable: durable as DurableAnalysisCache<EventProposal> | undefined });
    const allReferences = await asyncCall(() => store.purchaseOrderReferences(org));
    const boundProposal = await ensureProposalForRun(bound.run, org);
    return c.json({
      proposal: bound.run.result,
      run: bound.run,
      cacheHit: bound.cacheHit,
      status: bound.run.status,
      usage: bound.run.usage ?? null,
      runUsage: bound.run.usage ?? null,
      poCandidates: findPoCandidates(claim.ocrText, allReferences),
      baseline: { poReference: selectedReference.poNumber, eta: selectedOrder.eta },
      changeProposal: boundProposal,
    });
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
    // Paste-first parity for documents: when OCR yields a commitment, suggest the
    // referenced PO so the reviewer can bind it without retyping anything.
    const docClaimForCandidates = docClaim(analysis.run);
    const docOrg = requestOrg(c) ?? DEFAULT_ORG;
    const docCandidates = docClaimForCandidates && docClaimForCandidates.ocrText.trim()
      ? findPoCandidates(docClaimForCandidates.ocrText, await asyncCall(() => store.purchaseOrderReferences(docOrg)))
      : [];
    return c.json({ ...analysis, status: analysis.run.status, usage: analysis.cacheHit ? { inputTokens: 0, outputTokens: 0, totalTokens: 0 } : analysis.run.usage ?? null, runUsage: analysis.run.usage ?? null, poCandidates: docCandidates });
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
  options.agent?.bind(async (id, org) => {
    const configured = getConfiguredProvider();
    const adapter = options.extractionAdapter ?? configured.extractionAdapter;
    if (!adapter) throw new Error("AI provider is not configured");
    const result = await processMessage(id, org, adapter, configured);
    if (!result || result.status === "FAILED") return { status: "FAILED", subject: "Supplier message could not be checked", text: "Open Messages to read the supplier update and try again." };
    if (result.status === "REVIEW_REQUIRED") return { status: "REVIEW_REQUIRED", subject: "ProcureBrain: choose the order for a supplier message", text: `We need your help to find the order for this supplier message.\nSender: ${result.message?.sender ?? "Pasted message"}\nSubject: ${result.message?.subject ?? "Supplier update"}\n\nThe order has not changed. Open Messages and choose the correct order.` };
    const proposal = result.runKey ? await asyncCall(() => store.getProposalByRunKey(result.runKey!, org)) : undefined;
    const analyzedRun = result.runKey ? (durable ? await durable.get(result.runKey) : cache.get(result.runKey)) : undefined;
    const analyzed = EventProposalSchema.safeParse(analyzedRun?.result);
    const baseline = (analyzedRun?.request.context ?? {}) as Record<string, unknown>;
    const commitment = analyzed.success ? analyzed.data.commitment : null;
    const combinedChange = commitment && commitment.eta !== null && commitment.eta !== baseline.baselineEta && commitment.quantity !== null && commitment.quantity !== baseline.baselineQuantity;
    if (!proposal && (combinedChange || (analyzed.success && analyzed.data.state !== "VALID"))) {
      const reason = combinedChange ? "The delivery date and quantity both changed. This prototype cannot prepare both changes together. Update your order record outside this app." : analyzed.success && analyzed.data.reason?.startsWith("A newer supplier message") ? analyzed.data.reason : analyzed.success && analyzed.data.reason?.startsWith("This email has unread attachments") ? analyzed.data.reason : "We could not confirm a clear delivery date or quantity change. Read the message and ask the supplier to confirm the details.";
      return { status: "REVIEW_REQUIRED", subject: "ProcureBrain: supplier message needs your help", text: `${reason}\n\nSender: ${result.message?.sender ?? "Pasted message"}\nSubject: ${result.message?.subject ?? "Supplier update"}\n\nOriginal message:\n${result.message?.text.slice(0, 1200) ?? "Open the saved source"}\n\nThe order has not changed. Ask the supplier to confirm the delivery date or quantity.` };
    }
    if (!proposal || proposal.status !== "PENDING") return { status: "NO_CHANGE", subject: "No pending change", text: "The message was checked. No delivery date or quantity change is waiting for your decision." };
    const run = durable ? await durable.get(proposal.analysisRunKey) : cache.get(proposal.analysisRunKey);
    const context = (run?.request.context ?? {}) as Record<string, unknown>;
    const reference = await asyncCall(() => store.purchaseOrderReference(proposal.entityId, org));
    const order = await asyncCall(() => store.state(proposal.entityId));
    const oldValue = proposal.proposalType === "ETA_CHANGE" ? context.baselineEta : context.baselineQuantity;
    const newValue = proposal.proposalType === "ETA_CHANGE" ? proposal.payload.eta : proposal.payload.quantity;
    const days = proposal.proposalType === "ETA_CHANGE" && typeof oldValue === "string" && typeof newValue === "string" ? Math.round((Date.parse(newValue)-Date.parse(oldValue))/86400000) : null;
    const name = reference?.poNumber ?? proposal.entityId;
    const field = proposal.proposalType === "ETA_CHANGE" ? "delivery date" : "quantity";
    const displayValue = (value: unknown) => {
      if (value == null) return "Not recorded";
      if (proposal.proposalType !== "ETA_CHANGE") return `${value} units`;
      const date = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
      return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(date) : String(value);
    };
    return { status: "PROPOSAL_CREATED", proposalId: proposal.id, subject: `ProcureBrain: check the ${field} for ${name}`, text: `Order: ${name}\nSupplier: ${order?.supplierName ?? "Unknown supplier"}\nCurrent ${field}: ${displayValue(oldValue)}\nSuggested ${field}: ${displayValue(newValue)}${days !== null && Number.isFinite(days) ? `\nDelivery is ${Math.abs(days)} days ${days > 0 ? "later" : days < 0 ? "earlier" : "unchanged"}.` : ""}\nMessage from: ${result.message?.sender ?? "Pasted message"}\nMessage title: ${result.message?.subject ?? "Supplier update"}\n\nSupplier message (first 1,200 characters):\n${result.message?.text.slice(0, 1200) ?? "Open Messages to read the original"}\n\nThe order has not changed. Read the supplier message, then choose whether to update the order.` };
  });
  return app;
}

import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { MemoryStore as DefaultMemoryStore } from "./store";
import type { NormalizationResult } from "../../../packages/ingestion/src";
function requireMemoryStore() { return DefaultMemoryStore; }
function sha256(value: string) { return createHash("sha256").update(value).digest("hex"); }
/** Tenant resolution: x-organization-id header, default org-dev. Null means the header was malformed. */
function requestOrg(c: Context): string | null {
  const org = c.req.header("x-organization-id")?.trim() || DEFAULT_ORG;
  return /^[a-z0-9](?:[a-z0-9-]{0,63})$/.test(org) ? org : null;
}
function extractsPoToken(message: string): boolean {
  return /\bPO\s*[-#]?\s*[A-Z0-9][A-Z0-9\-]*\b/i.test(message);
}
/** Reads a stored document run back into its commitment plus OCR claim text. Null when there is nothing bindable. */
function docClaim(run: { result?: unknown; modelRequest?: unknown }): { commitment: SupplierCommitment; ocrText: string } | null {
  const result = (run.result ?? null) as { commitment?: unknown; ocr?: { text?: unknown } } | null;
  if (!result || typeof result !== "object" || result.commitment === null || result.commitment === undefined) return null;
  const parsed = SupplierCommitmentSchema.safeParse(result.commitment);
  if (!parsed.success) return null;
  let ocrText = "";
  if (result.ocr && typeof result.ocr === "object" && typeof result.ocr.text === "string") ocrText = result.ocr.text;
  else {
    const modelRequest = run.modelRequest as { ocrText?: unknown } | undefined;
    if (typeof modelRequest?.ocrText === "string") ocrText = modelRequest.ocrText;
  }
  return { commitment: parsed.data, ocrText };
}
function findPoCandidates(message: string, references: readonly PurchaseOrderReference[]): Array<{ entityId: string; poNumber: string }> {
  const tokens = message.match(/\bPO\s*[-#]?\s*[A-Z0-9][A-Z0-9\-]*\b/gi) ?? [];
  const normalizedTokens = new Set(tokens.map((token) => normalizePoReference(token)));
  if (normalizedTokens.size === 0) return [];
  const candidates = references.filter((reference) =>
    [reference.poNumber, ...(reference.aliases ?? [])].some((candidate) => {
      const normalized = normalizePoReference(candidate);
      if (normalizedTokens.has(normalized)) return true;
      // Allow "PO-1001" in text to match stored "PO-1001" and bare "1001" alias forms.
      return [...normalizedTokens].some((token) => token.endsWith(normalized) || normalized.endsWith(token));
    }),
  );
  return candidates.map(({ entityId, poNumber }) => ({ entityId, poNumber }));
}
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
