import { detectExceptions } from "../../../packages/domain/src/exceptions";
import { replayPurchaseOrder } from "../../../packages/domain/src/reducer";
import type { PurchaseOrderState } from "../../../packages/domain/src/purchase-order";
import { sortExceptions } from "../../../packages/domain/src/priority";
import type { Event } from "../../../packages/domain/src/events";
import { normalizeCsv, normalizePoReference, normalizePurchaseOrdersCsv, normalizeRows, type InputRow, type NormalizationResult, type PurchaseOrderReference } from "../../../packages/ingestion/src";
import { canonicalEventId, idempotencyKey } from "../../../packages/ingestion/src/idempotency";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface ImportResult { sourceRecordId: string; inserted: number; events: readonly Event[]; unresolved: readonly unknown[]; rejected: readonly unknown[] }
/** Default organization for requests without x-organization-id. Its imports keep legacy global entity ids (migration-safe); other orgs get isolated po_<org>_ namespaces. */
export const DEFAULT_ORG = "org-dev";

/**
 * Org-scoped entity namespace. Default-org callers keep the historical global
 * ids so existing deployments and fixtures are untouched; every other org gets
 * an isolated namespace so the same po_number can exist in two organizations.
 */
export function scopedEntityId(organizationId: string, entityId: string): string {
  if (organizationId === DEFAULT_ORG || entityId.startsWith(`po_${organizationId}_`)) return entityId;
  return `po_${organizationId}_${entityId.replace(/^po[-_]/, "")}`;
}

/**
 * Remaps batch import events for newly created POs into the org namespace,
 * regenerating content-addressed ids so cross-org reimports stay idempotent
 * per org. Events for already-known (resolved) entities pass through.
 */
export function scopeImportEvents(events: readonly Event[], organizationId: string): Event[] {
  if (organizationId === DEFAULT_ORG) return [...events];
  const created = new Map<string, string>();
  for (const event of events) {
    if (event.eventType === "PO_CREATED" && !created.has(event.entityId)) {
      created.set(event.entityId, scopedEntityId(organizationId, event.entityId));
    }
  }
  if ([...created].every(([from, to]) => from === to)) return [...events];
  return events.map((event) => {
    const entityId = created.get(event.entityId) ?? event.entityId;
    if (entityId === event.entityId) return { ...event };
    return {
      ...event,
      entityId,
      id: canonicalEventId({ sourceRecordId: event.sourceRecordId, entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload }),
    };
  });
}

export interface Supplier {
  readonly id: string;
  readonly organizationId: string;
  readonly supplierCode: string;
  readonly name: string;
  readonly primaryEmail: string | null;
  readonly emailDomain: string | null;
  readonly phone: string | null;
  readonly country: string | null;
  readonly currency: string | null;
  readonly defaultPaymentTerms: string | null;
  readonly status: string;
}

export interface NewSupplier {
  readonly supplierCode: string;
  readonly name: string;
  readonly primaryEmail?: string;
  readonly emailDomain?: string;
  readonly phone?: string;
  readonly country?: string;
  readonly currency?: string;
  readonly defaultPaymentTerms?: string;
  readonly status?: string;
}

export function supplierIdFor(organizationId: string, supplierCode: string): string {
  const slug = supplierCode.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `sup_${organizationId}_${slug || "unknown"}`;
}

export class SupplierConflictError extends Error {
  constructor(readonly supplierCode: string) {
    super(`Supplier ${supplierCode} already exists in this organization.`);
  }
}

export type MessageStatus =
  | "RECEIVED" | "MATCHING" | "ANALYZING" | "PROPOSAL_CREATED"
  | "REVIEW_REQUIRED" | "PROCESSED" | "IGNORED" | "FAILED";

export type MatchMethod = "EXACT_PO_REFERENCE" | "THREAD_HISTORY" | "SUPPLIER_OPEN_PO" | "USER_SELECTED" | "MODEL_SUGGESTED";

export interface SupplierMessage {
  readonly id: string;
  readonly organizationId: string;
  readonly supplierId: string | null;
  readonly sourceRecordId: string;
  readonly channel: string;
  readonly externalMessageId: string | null;
  readonly threadId: string | null;
  readonly sender: string | null;
  readonly recipients: readonly string[] | null;
  readonly subject: string | null;
  readonly text: string;
  readonly sentAt: string | null;
  readonly receivedAt: string;
  readonly processingStatus: MessageStatus;
  readonly proposalRunKey: string | null;
  readonly createdAt: string;
}

export interface NewSupplierMessage {
  readonly channel: string;
  readonly sender?: string;
  readonly recipients?: readonly string[];
  readonly subject?: string;
  readonly text: string;
  readonly sentAt?: string;
  readonly receivedAt?: string;
  readonly externalMessageId?: string;
  readonly threadId?: string;
}

export interface MessageCandidate {
  readonly messageId: string;
  readonly entityId: string;
  readonly matchMethod: MatchMethod;
  readonly matchScore: number | null;
  readonly isSelected: boolean;
}

export function messageIdFor(organizationId: string, channel: string, externalMessageId: string | null, text: string): string {
  const basis = externalMessageId ?? `manual-${createHash("sha256").update(`${organizationId}\n${channel}\n${text}`).digest("hex")}`;
  return `msg_${createHash("sha256").update(`${organizationId}\n${channel}\n${basis}`).digest("hex").slice(0, 24)}`;
}

export type ProposalType = "ETA_CHANGE" | "QUANTITY_CHANGE";
export type ProposalStatus = "PENDING" | "APPROVED" | "EDITED_AND_APPROVED" | "REJECTED" | "STALE" | "APPLIED";

export interface ChangeProposal {
  readonly id: string;
  readonly organizationId: string;
  readonly analysisRunKey: string;
  readonly messageId: string | null;
  readonly entityId: string;
  readonly proposalType: ProposalType;
  readonly payload: { readonly eta?: string | null; readonly quantity?: number | null };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly reviewState: string;
  readonly baselineRevision: string;
  readonly status: ProposalStatus;
  readonly sourceRecordId: string;
  readonly sourceType: string;
  readonly createdAt: string;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly reviewedNote: string | null;
  readonly appliedAt: string | null;
}

export interface NewChangeProposal {
  readonly analysisRunKey: string;
  readonly messageId?: string | null;
  readonly entityId: string;
  readonly proposalType: ProposalType;
  readonly payload: { readonly eta?: string | null; readonly quantity?: number | null };
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly reviewState: string;
  readonly baselineRevision: string;
  readonly organizationId: string;
  readonly sourceRecordId: string;
  readonly sourceType: string;
}

export function proposalIdFor(analysisRunKey: string): string {
  return `prop_${createHash("sha256").update(analysisRunKey).digest("hex").slice(0, 16)}`;
}

const PROPOSAL_TRANSITIONS: Readonly<Record<ProposalStatus, readonly ProposalStatus[]>> = {
  PENDING: ["APPROVED", "EDITED_AND_APPROVED", "REJECTED", "STALE"],
  APPROVED: ["APPLIED", "STALE"],
  EDITED_AND_APPROVED: ["APPLIED", "STALE"],
  REJECTED: [],
  STALE: [],
  APPLIED: [],
};

export interface ApprovedQuantityChange {
  entityId: string;
  expectedQuantity: number | null;
  expectedRevision: string;
  approvalId: string;
  quantity: number;
  approvedAt: string;
  sourceRecordId: string;
  sourceText: string;
  sourceType?: string;
  organizationId?: string;
}

export type ApplyQuantityResult = ApplyEtaResult;
export interface ApprovedEtaChange {
  entityId: string;
  expectedEta: string | null;
  expectedRevision: string;
  approvalId: string;
  eta: string;
  approvedAt: string;
  sourceRecordId: string;
  sourceText: string;
  /** Channel the approved claim arrived on; defaults to pasted supplier_message. */
  sourceType?: string;
  /** Tenant boundary: when present the PO must belong to this org, and the source is stamped with it. */
  organizationId?: string;
}
export class SourceRecordConflictError extends Error {
  constructor(readonly sourceRecordId: string) {
    super("This source ID already belongs to different evidence. Use a new source ID.");
  }
}

export function purchaseOrderRevision(state: PurchaseOrderState): string {
  return createHash("sha256").update(JSON.stringify(state.appliedEventIds)).digest("hex");
}

function assertSourceIdentity(record: { content: string; sourceType: string } | undefined, content: string, sourceType: string, id: string): void {
  if (record && (record.content !== content || record.sourceType !== sourceType)) throw new SourceRecordConflictError(id);
}
export type ApplyEtaResult =
  | { status: "applied"; event: Event }
  | { status: "already_applied"; event: Event }
  | { status: "stale"; currentEta: string | null }
  | { status: "unchanged" }
  | { status: "unknown_po" };

interface StoredReference extends PurchaseOrderReference {
  organizationId: string;
  supplierName: string | null;
}

const initialStoredReferences: StoredReference[] = [
  { entityId: "po-1", poNumber: "PO-1001", aliases: ["1001"], organizationId: DEFAULT_ORG, supplierName: "Northstar Components" },
  { entityId: "po-2", poNumber: "PO-1002", aliases: ["1002"], organizationId: DEFAULT_ORG, supplierName: "Atlas Industrial" },
];

const fixture: Event[] = [
  { id: "created-1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "PO_CREATED", occurredAt: "2025-01-01T00:00:00Z", ingestedAt: "2025-01-01T00:00:01Z", sourceRecordId: "fixture", payload: { supplierName: "Northstar Components", quantity: 10 }, schemaVersion: 1 },
  { id: "eta-1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "SUPPLIER_ETA_CONFIRMED", occurredAt: "2025-01-02T00:00:00Z", ingestedAt: "2025-01-02T00:00:01Z", sourceRecordId: "fixture", payload: { eta: "2025-01-10" }, schemaVersion: 1 },
  { id: "eta-2", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "SUPPLIER_ETA_CHANGED", occurredAt: "2025-01-03T00:00:00Z", ingestedAt: "2025-01-03T00:00:01Z", sourceRecordId: "fixture", payload: { eta: "2025-01-20" }, schemaVersion: 1 },
  { id: "qty-1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "SUPPLIER_QUANTITY_REDUCED", occurredAt: "2025-01-04T00:00:00Z", ingestedAt: "2025-01-04T00:00:01Z", sourceRecordId: "fixture", payload: { quantity: 8 }, schemaVersion: 1 },
  { id: "receipt-1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: "2025-01-05T00:00:00Z", ingestedAt: "2025-01-05T00:00:01Z", sourceRecordId: "fixture", payload: { quantity: 3 }, schemaVersion: 1 },
  { id: "created-2", entityType: "PURCHASE_ORDER", entityId: "po-2", eventType: "PO_CREATED", occurredAt: "2025-01-10T00:00:00Z", ingestedAt: "2025-01-10T00:00:01Z", sourceRecordId: "fixture", payload: { supplierName: "Atlas Industrial", quantity: 24 }, schemaVersion: 1 },
];

export class MemoryStore {
  private events: Event[] = [...fixture];
  private readonly sourceRecords = new Map<string, { id: string; content: string; sourceType: string; organizationId: string; importedAt: string }>();
  private references: StoredReference[] = initialStoredReferences.map((reference) => ({ ...reference }));
  private supplierById = new Map<string, Supplier>();
  private messages = new Map<string, SupplierMessage & { candidates: MessageCandidate[] }>();

  private scopedReferences(organizationId?: string): PurchaseOrderReference[] {
    const refs = organizationId === undefined ? this.references : this.references.filter((reference) => reference.organizationId === organizationId);
    return refs.map(({ organizationId: _org, supplierName: _supplier, ...reference }) => reference);
  }

  importCsv(csv: string, sourceRecordId: string, _sourceType?: string, organizationId: string = DEFAULT_ORG): ImportResult {
    const result = normalizeImportCsv(csv, sourceRecordId, this.scopedReferences(organizationId), _sourceType);
    return this.add(scopeImportEvents(result.events, organizationId), sourceRecordId, result.unresolved, result.rejected, csv, _sourceType ?? "supplier_updates", organizationId);
  }

  importRows(rows: Parameters<typeof normalizeRows>[0], sourceRecordId: string, _sourceType?: string, organizationId: string = DEFAULT_ORG): ImportResult {
    const result = normalizeImportRows(rows, sourceRecordId, this.scopedReferences(organizationId), _sourceType);
    return this.add(scopeImportEvents(result.events, organizationId), sourceRecordId, result.unresolved, result.rejected, JSON.stringify(rows), _sourceType ?? "supplier_updates", organizationId);
  }

  private add(events: readonly Event[], sourceRecordId: string, unresolved: readonly unknown[], rejected: readonly unknown[], content: string, sourceType: string, organizationId: string): ImportResult {
    assertSourceIdentity(this.sourceRecords.get(sourceRecordId), content, sourceType, sourceRecordId);
    if (!this.sourceRecords.has(sourceRecordId)) this.sourceRecords.set(sourceRecordId, { id: sourceRecordId, content, sourceType, organizationId, importedAt: new Date().toISOString() });
    const ids = new Set(this.events.map((event) => event.id));
    const fresh = events.filter((event) => !ids.has(event.id));
    this.events.push(...fresh);
    for (const event of fresh) if (event.eventType === "PO_CREATED" && !this.references.some((po) => po.entityId === event.entityId)) {
      const lineItems = event.payload.lineItems as Array<{ poReference?: string }> | undefined;
      const poNumber = String(lineItems?.[0]?.poReference ?? event.entityId.replace(/^po_/, ""));
      const payload = event.payload as { supplierName?: unknown };
      this.references.push({
        entityId: event.entityId,
        poNumber,
        organizationId,
        supplierName: typeof payload.supplierName === "string" ? payload.supplierName : null,
      });
    }
    return { sourceRecordId, inserted: fresh.length, events: fresh, unresolved, rejected };
  }

  allEvents(): readonly Event[] { return this.events; }
  sources() { return [...this.sourceRecords.values()].map(({ content: _content, ...record }) => record); }
  source(id: string) { return this.sourceRecords.get(id); }
  purchaseOrderReference(entityId: string, organizationId?: string): PurchaseOrderReference | undefined {
    return this.scopedReferences(organizationId).find((reference) => reference.entityId === entityId);
  }
  purchaseOrderReferences(organizationId?: string): PurchaseOrderReference[] {
    return this.scopedReferences(organizationId).map((reference) => ({ ...reference }));
  }
  suppliers(organizationId: string): Supplier[] {
    return [...this.supplierById.values()].filter((supplier) => supplier.organizationId === organizationId);
  }
  supplier(id: string, organizationId?: string): Supplier | undefined {
    const supplier = this.supplierById.get(id);
    return supplier && (organizationId === undefined || supplier.organizationId === organizationId) ? supplier : undefined;
  }
  createSupplier(input: NewSupplier, organizationId: string): Supplier {
    const id = supplierIdFor(organizationId, input.supplierCode);
    const existing = this.supplierById.get(id);
    if (existing && existing.organizationId === organizationId) throw new SupplierConflictError(input.supplierCode);
    const supplier: Supplier = {
      id,
      organizationId,
      supplierCode: input.supplierCode.trim(),
      name: input.name.trim(),
      primaryEmail: input.primaryEmail?.trim() || null,
      emailDomain: (input.emailDomain ?? input.primaryEmail?.split("@")[1] ?? "").trim().toLowerCase() || null,
      phone: input.phone?.trim() || null,
      country: input.country?.trim() || null,
      currency: input.currency?.trim() || null,
      defaultPaymentTerms: input.defaultPaymentTerms?.trim() || null,
      status: input.status?.trim() || "active",
    };
    this.supplierById.set(id, supplier);
    return supplier;
  }
  supplierPurchaseOrders(supplierId: string, organizationId: string): PurchaseOrderState[] {
    const supplier = this.supplier(supplierId, organizationId);
    if (!supplier) return [];
    return this.references
      .filter((reference) => reference.organizationId === organizationId && reference.supplierName === supplier.name)
      .map(({ entityId }) => replayPurchaseOrder(this.events.filter((event) => event.entityId === entityId), entityId));
  }
  createMessage(input: NewSupplierMessage, organizationId: string): { status: "created" | "existing"; message: SupplierMessage } {
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const id = messageIdFor(organizationId, input.channel, input.externalMessageId ?? null, input.text);
    const existing = this.messages.get(id);
    if (existing && existing.organizationId === organizationId) {
      if (existing.text !== input.text) throw new SourceRecordConflictError(id);
      const { candidates: _candidates, ...message } = existing;
      return { status: "existing", message };
    }
    const now = new Date().toISOString();
    const full: SupplierMessage & { candidates: MessageCandidate[] } = {
      id,
      organizationId,
      supplierId: null,
      sourceRecordId: id,
      channel: input.channel,
      externalMessageId: input.externalMessageId ?? null,
      threadId: input.threadId ?? null,
      sender: input.sender ?? null,
      recipients: input.recipients ?? null,
      subject: input.subject ?? null,
      text: input.text,
      sentAt: input.sentAt ?? null,
      receivedAt,
      processingStatus: "RECEIVED",
      proposalRunKey: null,
      createdAt: now,
      candidates: [],
    };
    this.messages.set(id, full);
    if (!this.sourceRecords.has(id)) {
      this.sourceRecords.set(id, { id, content: input.text, sourceType: input.channel, organizationId, importedAt: now });
    }
    const { candidates: _omitted, ...message } = full;
    return { status: "created", message };
  }
  getMessage(id: string, organizationId: string): SupplierMessage | undefined {
    const message = this.messages.get(id);
    if (!message || message.organizationId !== organizationId) return undefined;
    const { candidates: _candidates, ...stripped } = message;
    return stripped;
  }
  listMessages(organizationId: string): SupplierMessage[] {
    return [...this.messages.values()]
      .filter((message) => message.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map(({ candidates: _candidates, ...stripped }) => stripped);
  }
  saveMessageCandidates(messageId: string, candidates: ReadonlyArray<{ entityId: string; matchMethod: MatchMethod; matchScore?: number | null }>, selectedEntityId?: string): MessageCandidate[] {
    const message = this.messages.get(messageId);
    if (!message) return [];
    const seen = new Set<string>();
    const deduped: MessageCandidate[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.entityId)) continue;
      seen.add(candidate.entityId);
      deduped.push({
        messageId,
        entityId: candidate.entityId,
        matchMethod: candidate.matchMethod,
        matchScore: candidate.matchScore ?? null,
        isSelected: selectedEntityId !== undefined && candidate.entityId === selectedEntityId,
      });
    }
    message.candidates.splice(0, message.candidates.length, ...deduped);
    return message.candidates.map((candidate) => ({ ...candidate }));
  }
  getMessageCandidates(messageId: string): MessageCandidate[] {
    return (this.messages.get(messageId)?.candidates ?? []).map((candidate) => ({ ...candidate }));
  }
  setMessageStatus(id: string, status: MessageStatus, patch?: { supplierId?: string | null; proposalRunKey?: string | null }): SupplierMessage | undefined {
    const message = this.messages.get(id);
    if (!message) return undefined;
    const next: SupplierMessage & { candidates: MessageCandidate[] } = {
      ...message,
      processingStatus: status,
      supplierId: patch?.supplierId !== undefined ? patch.supplierId : message.supplierId,
      proposalRunKey: patch?.proposalRunKey !== undefined ? patch.proposalRunKey : message.proposalRunKey,
    };
    this.messages.set(id, next);
    const { candidates: _candidates, ...stripped } = next;
    return stripped;
  }
  private proposals = new Map<string, ChangeProposal>();
  ensureProposal(input: NewChangeProposal): { status: "created" | "existing"; proposal: ChangeProposal } {
    const id = proposalIdFor(input.analysisRunKey);
    const existing = this.proposals.get(id);
    if (existing && existing.organizationId === input.organizationId) return { status: "existing", proposal: existing };
    const now = new Date().toISOString();
    const proposal: ChangeProposal = {
      id,
      organizationId: input.organizationId,
      analysisRunKey: input.analysisRunKey,
      messageId: input.messageId ?? null,
      entityId: input.entityId,
      proposalType: input.proposalType,
      payload: input.payload,
      evidence: input.evidence,
      reviewState: input.reviewState,
      baselineRevision: input.baselineRevision,
      status: "PENDING",
      sourceRecordId: input.sourceRecordId,
      sourceType: input.sourceType,
      createdAt: now,
      reviewedAt: null,
      reviewedBy: null,
      reviewedNote: null,
      appliedAt: null,
    };
    this.proposals.set(id, proposal);
    return { status: "created", proposal };
  }
  getProposal(id: string, organizationId: string): ChangeProposal | undefined {
    const proposal = this.proposals.get(id);
    return proposal && proposal.organizationId === organizationId ? proposal : undefined;
  }
  getProposalByRunKey(analysisRunKey: string, organizationId: string): ChangeProposal | undefined {
    const proposal = this.proposals.get(proposalIdFor(analysisRunKey));
    return proposal && proposal.organizationId === organizationId ? proposal : undefined;
  }
  listProposals(organizationId: string): ChangeProposal[] {
    return [...this.proposals.values()]
      .filter((proposal) => proposal.organizationId === organizationId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  transitionProposal(id: string, organizationId: string, to: ProposalStatus, patch?: { reviewedBy?: string; reviewedNote?: string }): { status: "ok" | "not_found" | "illegal"; proposal?: ChangeProposal } {
    const proposal = this.getProposal(id, organizationId);
    if (!proposal) return { status: "not_found" };
    if (!PROPOSAL_TRANSITIONS[proposal.status].includes(to)) {
      return proposal.status === to ? { status: "ok", proposal } : { status: "illegal", proposal };
    }
    const now = new Date().toISOString();
    const next: ChangeProposal = {
      ...proposal,
      status: to,
      reviewedAt: ["APPROVED", "EDITED_AND_APPROVED", "REJECTED"].includes(to) ? now : proposal.reviewedAt,
      reviewedBy: patch?.reviewedBy ?? proposal.reviewedBy,
      reviewedNote: patch?.reviewedNote ?? proposal.reviewedNote,
      appliedAt: to === "APPLIED" ? now : proposal.appliedAt,
    };
    this.proposals.set(id, next);
    return { status: "ok", proposal: next };
  }
  applyApprovedQuantityChange(input: ApprovedQuantityChange): ApplyQuantityResult {
    const reference = this.references.find((item) => item.entityId === input.entityId);
    if (!reference || (input.organizationId !== undefined && reference.organizationId !== input.organizationId)) {
      return { status: "unknown_po" };
    }
    const current = this.state(input.entityId);
    if (!current) return { status: "unknown_po" };
    const baseline = current.confirmedQuantity ?? current.orderedQuantity;
    const existing = this.events.find((item) => item.id === approvedQuantityEventId(input));
    if (existing) return { status: "already_applied", event: existing };
    if (baseline !== input.expectedQuantity || purchaseOrderRevision(current) !== input.expectedRevision) {
      return { status: "stale", currentEta: current.eta };
    }
    if (baseline === input.quantity) return { status: "unchanged" };
    const organizationId = input.organizationId ?? reference.organizationId;
    assertSourceIdentity(this.sourceRecords.get(input.sourceRecordId), input.sourceText, input.sourceType ?? "supplier_message", input.sourceRecordId);
    const event = approvedQuantityEvent(input, current);
    if (!this.sourceRecords.has(input.sourceRecordId)) this.sourceRecords.set(input.sourceRecordId, {
      id: input.sourceRecordId,
      content: input.sourceText,
      sourceType: input.sourceType ?? "supplier_message",
      organizationId,
      importedAt: new Date().toISOString(),
    });
    this.events.push(event);
    return { status: "applied", event };
  }
  applyApprovedEtaChange(input: ApprovedEtaChange): ApplyEtaResult {
    const reference = this.references.find((item) => item.entityId === input.entityId);
    if (!reference || (input.organizationId !== undefined && reference.organizationId !== input.organizationId)) {
      return { status: "unknown_po" };
    }
    const current = this.state(input.entityId);
    if (!current) return { status: "unknown_po" };
    const existing = this.events.find((item) => item.id === approvedEtaEventId(input));
    if (existing) return { status: "already_applied", event: existing };
    if (current.eta !== input.expectedEta || purchaseOrderRevision(current) !== input.expectedRevision) return { status: "stale", currentEta: current.eta };
    if (current.eta === input.eta) return { status: "unchanged" };
    const organizationId = input.organizationId ?? reference.organizationId;
    assertSourceIdentity(this.sourceRecords.get(input.sourceRecordId), input.sourceText, input.sourceType ?? "supplier_message", input.sourceRecordId);
    const event = approvedEtaEvent(input, current);
    if (!this.sourceRecords.has(input.sourceRecordId)) this.sourceRecords.set(input.sourceRecordId, {
      id: input.sourceRecordId,
      content: input.sourceText,
      sourceType: input.sourceType ?? "supplier_message",
      organizationId,
      importedAt: new Date().toISOString(),
    });
    this.events.push(event);
    return { status: "applied", event };
  }
  purchaseOrders(organizationId?: string): PurchaseOrderState[] {
    const refs = organizationId === undefined ? this.references : this.references.filter((reference) => reference.organizationId === organizationId);
    return refs.map(({ entityId }) => replayPurchaseOrder(this.events.filter((event) => event.entityId === entityId), entityId));
  }
  state(id: string): PurchaseOrderState | undefined {
    const events = this.events.filter((event) => event.entityId === id);
    return events.length ? replayPurchaseOrder(events, id) : undefined;
  }
  timeline(id: string): Event[] { return this.events.filter((event) => event.entityId === id).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id)); }
  exceptions() { return sortExceptions(detectExceptions(this.events, { now: new Date().toISOString() })); }
}

/** PostgreSQL store used whenever DATABASE_URL is configured. Unlike MemoryStore, its data survives restarts. */
export class PostgresStore {
  constructor(private readonly pool: Pool) {}

  private async references(organizationId?: string): Promise<PurchaseOrderReference[]> {
    const result = organizationId === undefined
      ? await this.pool.query("select entity_id, po_number from purchase_orders")
      : await this.pool.query("select entity_id, po_number from purchase_orders where organization_id=$1", [organizationId]);
    return result.rows.map((row) => ({ entityId: row.entity_id, poNumber: row.po_number }));
  }

  private async entityEvents(entityId: string): Promise<Event[]> {
    return entityEventsQuery(this.pool, entityId);
  }

  async importCsv(csv: string, sourceRecordId: string, sourceType = "supplier_updates", organizationId: string = DEFAULT_ORG) {
    const refs = await this.references(organizationId);
    const normalized = normalizeImportCsv(csv, sourceRecordId, refs, sourceType);
    return this.persist(scopeImportEvents(normalized.events, organizationId), sourceRecordId, csv, sourceType, normalized.unresolved, normalized.rejected, organizationId);
  }

  async importRows(rows: Parameters<typeof normalizeRows>[0], sourceRecordId: string, sourceType = "supplier_updates", organizationId: string = DEFAULT_ORG) {
    const refs = await this.references(organizationId);
    const normalized = normalizeImportRows(rows, sourceRecordId, refs, sourceType);
    return this.persist(scopeImportEvents(normalized.events, organizationId), sourceRecordId, JSON.stringify(rows), sourceType, normalized.unresolved, normalized.rejected, organizationId);
  }

  private async persist(events: readonly Event[], id: string, content: string, sourceType: string, unresolved: readonly unknown[], rejected: readonly unknown[], organizationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockPurchaseOrders(client, events.map(event => event.entityId));
      await persistSourceRecord(client, id, content, sourceType, organizationId, { rowCount: events.length });
      let inserted = 0;
      const newlyInserted: Event[] = [];
      for (const event of events) {
        if (event.eventType === "PO_CREATED") {
          const reference = (event.payload.lineItems as Array<{ poReference?: string }> | undefined)?.[0]?.poReference ?? event.entityId;
          await client.query("insert into purchase_orders(entity_id,po_number,organization_id,normalized_po_number,supplier_id,supplier_name) values($1,$2,$3,$4,$5,$6) on conflict(entity_id) do nothing", [event.entityId, reference, organizationId, normalizePoReference(reference), event.payload.supplierId ?? null, event.payload.supplierName ?? null]);
        }
        const key = idempotencyKey({ sourceRecordId: event.sourceRecordId, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
        const result = await client.query("insert into canonical_events(id,idempotency_key,entity_type,entity_id,event_type,occurred_at,ingested_at,source_record_id,organization_id,payload,schema_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing", [event.id,key,event.entityType,event.entityId,event.eventType,event.occurredAt,event.ingestedAt,id,organizationId,event.payload,event.schemaVersion]);
        inserted += result.rowCount ?? 0;
        if (result.rowCount) newlyInserted.push(event);
      }
      await client.query("commit");
      return { sourceRecordId: id, inserted, events: newlyInserted, unresolved, rejected };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }

  async allEvents(): Promise<Event[]> {
    const rows = await this.pool.query("select id,entity_type as \"entityType\",entity_id as \"entityId\",event_type as \"eventType\",occurred_at as \"occurredAt\",ingested_at as \"ingestedAt\",source_record_id as \"sourceRecordId\",payload,schema_version as \"schemaVersion\" from canonical_events order by occurred_at,id");
    return rows.rows.map(toCanonicalEvent);
  }
  async source(id: string) { return (await this.pool.query("select id,source_type as \"sourceType\",source_name as \"sourceName\",content,metadata,organization_id as \"organizationId\",imported_at as \"importedAt\" from source_records where id=$1", [id])).rows[0]; }
  async sources() { return (await this.pool.query("select id,source_type as \"sourceType\",source_name as \"sourceName\",metadata,organization_id as \"organizationId\",imported_at as \"importedAt\" from source_records order by imported_at desc")).rows; }
  async purchaseOrderReference(entityId: string, organizationId?: string): Promise<PurchaseOrderReference | undefined> {
    const row = organizationId === undefined
      ? (await this.pool.query("select entity_id, po_number from purchase_orders where entity_id=$1", [entityId])).rows[0]
      : (await this.pool.query("select entity_id, po_number from purchase_orders where entity_id=$1 and organization_id=$2", [entityId, organizationId])).rows[0];
    return row ? { entityId: String(row.entity_id), poNumber: String(row.po_number) } : undefined;
  }
  async purchaseOrderReferences(organizationId?: string): Promise<PurchaseOrderReference[]> {
    return this.references(organizationId);
  }
  async suppliers(organizationId: string): Promise<Supplier[]> {
    const result = await this.pool.query("select id,organization_id as \"organizationId\",supplier_code as \"supplierCode\",name,primary_email as \"primaryEmail\",email_domain as \"emailDomain\",phone,country,currency,default_payment_terms as \"defaultPaymentTerms\",status from suppliers where organization_id=$1 order by name", [organizationId]);
    return result.rows.map(toSupplier);
  }
  async supplier(id: string, organizationId?: string): Promise<Supplier | undefined> {
    const row = organizationId === undefined
      ? (await this.pool.query("select id,organization_id as \"organizationId\",supplier_code as \"supplierCode\",name,primary_email as \"primaryEmail\",email_domain as \"emailDomain\",phone,country,currency,default_payment_terms as \"defaultPaymentTerms\",status from suppliers where id=$1", [id])).rows[0]
      : (await this.pool.query("select id,organization_id as \"organizationId\",supplier_code as \"supplierCode\",name,primary_email as \"primaryEmail\",email_domain as \"emailDomain\",phone,country,currency,default_payment_terms as \"defaultPaymentTerms\",status from suppliers where id=$1 and organization_id=$2", [id, organizationId])).rows[0];
    return row ? toSupplier(row) : undefined;
  }
  async createSupplier(input: NewSupplier, organizationId: string): Promise<Supplier> {
    const id = supplierIdFor(organizationId, input.supplierCode);
    const emailDomain = (input.emailDomain ?? input.primaryEmail?.split("@")[1] ?? "").trim().toLowerCase() || null;
    try {
      const result = await this.pool.query("insert into suppliers(id,organization_id,supplier_code,name,primary_email,email_domain,phone,country,currency,default_payment_terms,status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id,organization_id as \"organizationId\",supplier_code as \"supplierCode\",name,primary_email as \"primaryEmail\",email_domain as \"emailDomain\",phone,country,currency,default_payment_terms as \"defaultPaymentTerms\",status",
        [id, organizationId, input.supplierCode.trim(), input.name.trim(), input.primaryEmail?.trim() || null, emailDomain, input.phone?.trim() || null, input.country?.trim() || null, input.currency?.trim() || null, input.defaultPaymentTerms?.trim() || null, input.status?.trim() || "active"]);
      return toSupplier(result.rows[0]);
    } catch (error) {
      if (error instanceof Error && "code" in error && (error as { code?: string }).code === "23505") throw new SupplierConflictError(input.supplierCode);
      throw error;
    }
  }
  async supplierPurchaseOrders(supplierId: string, organizationId: string): Promise<PurchaseOrderState[]> {
    const supplier = await this.supplier(supplierId, organizationId);
    if (!supplier) return [];
    const refs = await this.pool.query("select entity_id from purchase_orders where organization_id=$1 and supplier_name=$2", [organizationId, supplier.name]);
    return Promise.all(refs.rows.map(async (row) => replayPurchaseOrder(await this.entityEvents(String(row.entity_id)), String(row.entity_id))));
  }
  async createMessage(input: NewSupplierMessage, organizationId: string): Promise<{ status: "created" | "existing"; message: SupplierMessage }> {
    const receivedAt = input.receivedAt ?? new Date().toISOString();
    const id = messageIdFor(organizationId, input.channel, input.externalMessageId ?? null, input.text);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query("select id from supplier_messages where id=$1 and organization_id=$2", [id, organizationId]);
      if (existing.rowCount) {
        await client.query("rollback");
        const message = await this.getMessage(id, organizationId);
        if (!message) throw new Error("Supplier message was not persisted");
        if (message.text !== input.text) throw new SourceRecordConflictError(id);
        return { status: "existing", message };
      }
      await persistSourceRecord(client, id, input.text, input.channel, organizationId, { message: true, sender: input.sender ?? null });
      const inserted = await client.query("insert into supplier_messages(id,organization_id,source_record_id,channel,external_message_id,thread_id,sender,recipients,subject,text_content,sent_at,received_at,processing_status) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'RECEIVED') returning id,organization_id as \"organizationId\",supplier_id as \"supplierId\",source_record_id as \"sourceRecordId\",channel,external_message_id as \"externalMessageId\",thread_id as \"threadId\",sender,recipients,subject,text_content as \"text\",sent_at as \"sentAt\",received_at as \"receivedAt\",processing_status as \"processingStatus\",proposal_run_key as \"proposalRunKey\",created_at as \"createdAt\"",
        [id, organizationId, id, input.channel, input.externalMessageId ?? null, input.threadId ?? null, input.sender ?? null, input.recipients ? JSON.stringify(input.recipients) : null, input.subject ?? null, input.text, input.sentAt ?? null, receivedAt]);
      await client.query("commit");
      return { status: "created", message: toSupplierMessage(inserted.rows[0]) };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async getMessage(id: string, organizationId: string): Promise<SupplierMessage | undefined> {
    const row = (await this.pool.query("select id,organization_id as \"organizationId\",supplier_id as \"supplierId\",source_record_id as \"sourceRecordId\",channel,external_message_id as \"externalMessageId\",thread_id as \"threadId\",sender,recipients,subject,text_content as \"text\",sent_at as \"sentAt\",received_at as \"receivedAt\",processing_status as \"processingStatus\",proposal_run_key as \"proposalRunKey\",created_at as \"createdAt\" from supplier_messages where id=$1 and organization_id=$2", [id, organizationId])).rows[0];
    return row ? toSupplierMessage(row) : undefined;
  }
  async listMessages(organizationId: string): Promise<SupplierMessage[]> {
    const result = await this.pool.query("select id,organization_id as \"organizationId\",supplier_id as \"supplierId\",source_record_id as \"sourceRecordId\",channel,external_message_id as \"externalMessageId\",thread_id as \"threadId\",sender,recipients,subject,text_content as \"text\",sent_at as \"sentAt\",received_at as \"receivedAt\",processing_status as \"processingStatus\",proposal_run_key as \"proposalRunKey\",created_at as \"createdAt\" from supplier_messages where organization_id=$1 order by created_at desc, id desc", [organizationId]);
    return result.rows.map(toSupplierMessage);
  }
  async saveMessageCandidates(messageId: string, candidates: ReadonlyArray<{ entityId: string; matchMethod: MatchMethod; matchScore?: number | null }>, selectedEntityId?: string): Promise<MessageCandidate[]> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from message_po_candidates where message_id=$1", [messageId]);
      const seen = new Set<string>();
      for (const candidate of candidates) {
        if (seen.has(candidate.entityId)) continue;
        seen.add(candidate.entityId);
        await client.query("insert into message_po_candidates(message_id,entity_id,match_method,match_score,is_selected) values($1,$2,$3,$4,$5)", [messageId, candidate.entityId, candidate.matchMethod, candidate.matchScore ?? null, selectedEntityId !== undefined && candidate.entityId === selectedEntityId]);
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    return this.getMessageCandidates(messageId);
  }
  async getMessageCandidates(messageId: string): Promise<MessageCandidate[]> {
    const result = await this.pool.query("select message_id as \"messageId\",entity_id as \"entityId\",match_method as \"matchMethod\",match_score as \"matchScore\",is_selected as \"isSelected\" from message_po_candidates where message_id=$1", [messageId]);
    return result.rows.map((row) => ({
      messageId: String(row.messageId),
      entityId: String(row.entityId),
      matchMethod: row.matchMethod as MatchMethod,
      matchScore: (row.matchScore ?? null) as number | null,
      isSelected: Boolean(row.isSelected),
    }));
  }
  async setMessageStatus(id: string, status: MessageStatus, patch?: { supplierId?: string | null; proposalRunKey?: string | null }): Promise<SupplierMessage | undefined> {
    const message = await this.getMessageById(id);
    if (!message) return undefined;
    const supplierId = patch?.supplierId !== undefined ? patch.supplierId : message.supplierId;
    const proposalRunKey = patch?.proposalRunKey !== undefined ? patch.proposalRunKey : message.proposalRunKey;
    await this.pool.query("update supplier_messages set processing_status=$2,supplier_id=$3,proposal_run_key=$4 where id=$1", [id, status, supplierId, proposalRunKey]);
    return this.getMessageById(id);
  }
  private async getMessageById(id: string): Promise<SupplierMessage | undefined> {
    const row = (await this.pool.query("select id,organization_id as \"organizationId\",supplier_id as \"supplierId\",source_record_id as \"sourceRecordId\",channel,external_message_id as \"externalMessageId\",thread_id as \"threadId\",sender,recipients,subject,text_content as \"text\",sent_at as \"sentAt\",received_at as \"receivedAt\",processing_status as \"processingStatus\",proposal_run_key as \"proposalRunKey\",created_at as \"createdAt\" from supplier_messages where id=$1", [id])).rows[0];
    return row ? toSupplierMessage(row) : undefined;
  }
  async ensureProposal(input: NewChangeProposal): Promise<{ status: "created" | "existing"; proposal: ChangeProposal }> {
    const id = proposalIdFor(input.analysisRunKey);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const existing = await client.query("select id from change_proposals where id=$1 and organization_id=$2", [id, input.organizationId]);
      if (existing.rowCount) {
        await client.query("rollback");
        const proposal = await this.getProposal(id, input.organizationId);
        if (!proposal) throw new Error("Change proposal was not persisted");
        return { status: "existing", proposal };
      }
      await client.query("insert into change_proposals(id,organization_id,analysis_run_key,message_id,entity_id,proposal_type,payload,evidence,review_state,baseline_revision,status,source_record_id,source_type) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'PENDING',$11,$12)",
        [id, input.organizationId, input.analysisRunKey, input.messageId ?? null, input.entityId, input.proposalType, input.payload, input.evidence, input.reviewState, input.baselineRevision, input.sourceRecordId, input.sourceType]);
      await client.query("commit");
      const proposal = await this.getProposal(id, input.organizationId);
      if (!proposal) throw new Error("Change proposal was not persisted");
      return { status: "created", proposal };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async getProposal(id: string, organizationId: string): Promise<ChangeProposal | undefined> {
    const row = (await this.pool.query(`${selectProposals} where id=$1 and organization_id=$2`, [id, organizationId])).rows[0];
    return row ? toChangeProposal(row) : undefined;
  }
  async getProposalByRunKey(analysisRunKey: string, organizationId: string): Promise<ChangeProposal | undefined> {
    const row = (await this.pool.query(`${selectProposals} where analysis_run_key=$1 and organization_id=$2`, [analysisRunKey, organizationId])).rows[0];
    return row ? toChangeProposal(row) : undefined;
  }
  async listProposals(organizationId: string): Promise<ChangeProposal[]> {
    const result = await this.pool.query(`${selectProposals} where organization_id=$1 order by created_at desc, id desc`, [organizationId]);
    return result.rows.map(toChangeProposal);
  }
  async transitionProposal(id: string, organizationId: string, to: ProposalStatus, patch?: { reviewedBy?: string; reviewedNote?: string }): Promise<{ status: "ok" | "not_found" | "illegal"; proposal?: ChangeProposal }> {
    const proposal = await this.getProposal(id, organizationId);
    if (!proposal) return { status: "not_found" };
    if (!PROPOSAL_TRANSITIONS[proposal.status].includes(to)) {
      return proposal.status === to ? { status: "ok", proposal } : { status: "illegal", proposal };
    }
    const now = new Date().toISOString();
    await this.pool.query("update change_proposals set status=$3,reviewed_at=coalesce(reviewed_at,case when $3 in ('APPROVED','EDITED_AND_APPROVED','REJECTED') then $4 else reviewed_at end),reviewed_by=coalesce($5,reviewed_by),reviewed_note=coalesce($6,reviewed_note),applied_at=case when $3='APPLIED' then $4 else applied_at end where id=$1 and organization_id=$2",
      [id, organizationId, to, now, patch?.reviewedBy ?? null, patch?.reviewedNote ?? null]);
    const next = await this.getProposal(id, organizationId);
    return next ? { status: "ok", proposal: next } : { status: "not_found" };
  }
  async applyApprovedQuantityChange(input: ApprovedQuantityChange): Promise<ApplyQuantityResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockPurchaseOrders(client, [input.entityId]);
      const reference = await client.query("select entity_id, organization_id from purchase_orders where entity_id=$1", [input.entityId]);
      if (!reference.rowCount) { await client.query("rollback"); return { status: "unknown_po" }; }
      const poOrg = String(reference.rows[0].organization_id ?? DEFAULT_ORG);
      if (input.organizationId !== undefined && input.organizationId !== poOrg) {
        await client.query("rollback"); return { status: "unknown_po" };
      }
      const rows = await client.query(`${selectEvents} where entity_id=$1 order by occurred_at,id`, [input.entityId]);
      const events = rows.rows.map(toCanonicalEvent);
      const existing = events.find(event => event.id === approvedQuantityEventId(input));
      if (existing) { await client.query("commit"); return { status: "already_applied", event: existing }; }
      if (!events.length) { await client.query("rollback"); return { status: "unknown_po" }; }
      const current = replayPurchaseOrder(events, input.entityId);
      const baseline = current.confirmedQuantity ?? current.orderedQuantity;
      if (baseline !== input.expectedQuantity || purchaseOrderRevision(current) !== input.expectedRevision) {
        await client.query("rollback"); return { status: "stale", currentEta: current.eta };
      }
      if (baseline === input.quantity) { await client.query("rollback"); return { status: "unchanged" }; }
      const event = approvedQuantityEvent(input, current);
      await persistSourceRecord(client, input.sourceRecordId, input.sourceText, input.sourceType ?? "supplier_message", input.organizationId ?? poOrg, { approved: true, approvedAt: input.approvedAt });
      const key = idempotencyKey({ sourceRecordId: event.sourceRecordId, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
      const inserted = await client.query(
        "insert into canonical_events(id,idempotency_key,entity_type,entity_id,event_type,occurred_at,ingested_at,source_record_id,organization_id,payload,schema_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing returning id",
        [event.id, key, event.entityType, event.entityId, event.eventType, event.occurredAt, event.ingestedAt, event.sourceRecordId, input.organizationId ?? poOrg, event.payload, event.schemaVersion],
      );
      await client.query("commit");
      return inserted.rowCount ? { status: "applied", event } : { status: "already_applied", event };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async applyApprovedEtaChange(input: ApprovedEtaChange): Promise<ApplyEtaResult> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await lockPurchaseOrders(client, [input.entityId]);
      const reference = await client.query("select entity_id, organization_id from purchase_orders where entity_id=$1", [input.entityId]);
      if (!reference.rowCount) { await client.query("rollback"); return { status: "unknown_po" }; }
      const poOrg = String(reference.rows[0].organization_id ?? DEFAULT_ORG);
      if (input.organizationId !== undefined && input.organizationId !== poOrg) {
        await client.query("rollback"); return { status: "unknown_po" };
      }
      const rows = await client.query(`${selectEvents} where entity_id=$1 order by occurred_at,id`, [input.entityId]);
      const events = rows.rows.map(toCanonicalEvent);
      const existing = events.find(event => event.id === approvedEtaEventId(input));
      if (existing) { await client.query("commit"); return { status: "already_applied", event: existing }; }
      if (!events.length) { await client.query("rollback"); return { status: "unknown_po" }; }
      const current = replayPurchaseOrder(events, input.entityId);
      if (current.eta !== input.expectedEta || purchaseOrderRevision(current) !== input.expectedRevision) {
        await client.query("rollback"); return { status: "stale", currentEta: current.eta };
      }
      if (current.eta === input.eta) { await client.query("rollback"); return { status: "unchanged" }; }
      const event = approvedEtaEvent(input, current);
      await persistSourceRecord(client, input.sourceRecordId, input.sourceText, input.sourceType ?? "supplier_message", input.organizationId ?? poOrg, { approved: true, approvedAt: input.approvedAt });
      const key = idempotencyKey({ sourceRecordId: event.sourceRecordId, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
      const inserted = await client.query(
        "insert into canonical_events(id,idempotency_key,entity_type,entity_id,event_type,occurred_at,ingested_at,source_record_id,organization_id,payload,schema_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict do nothing returning id",
        [event.id, key, event.entityType, event.entityId, event.eventType, event.occurredAt, event.ingestedAt, event.sourceRecordId, input.organizationId ?? poOrg, event.payload, event.schemaVersion],
      );
      await client.query("commit");
      return inserted.rowCount ? { status: "applied", event } : { status: "already_applied", event };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async analysisRuns() { return (await this.pool.query('select cache_key as "cacheKey", id, request, status, result, error, usage, fallback_tier as "fallbackTier", created_at as "createdAt", completed_at as "completedAt" from analysis_runs order by created_at desc limit 100')).rows; }
  async purchaseOrders(organizationId?: string) {
    const refs = await this.references(organizationId);
    return Promise.all(refs.map(async ({ entityId }) => replayPurchaseOrder(await this.entityEvents(entityId), entityId)));
  }
  async state(id: string) {
    const events = await this.entityEvents(id);
    return events.length ? replayPurchaseOrder(events, id) : undefined;
  }
  async timeline(id: string) { return this.entityEvents(id); }
  /** Full-stream scan stays until the purchase-order projection ticket (plan 7.5); per-PO paths above are scoped. */
  async exceptions() { return sortExceptions(detectExceptions(await this.allEvents(), { now: new Date().toISOString() })); }
}

const selectEvents = 'select id,entity_type as "entityType",entity_id as "entityId",event_type as "eventType",occurred_at as "occurredAt",ingested_at as "ingestedAt",source_record_id as "sourceRecordId",payload,schema_version as "schemaVersion" from canonical_events';

const selectProposals = 'select id,organization_id as "organizationId",analysis_run_key as "analysisRunKey",message_id as "messageId",entity_id as "entityId",proposal_type as "proposalType",payload,evidence,review_state as "reviewState",baseline_revision as "baselineRevision",status,source_record_id as "sourceRecordId",source_type as "sourceType",created_at as "createdAt",reviewed_at as "reviewedAt",reviewed_by as "reviewedBy",reviewed_note as "reviewedNote",applied_at as "appliedAt" from change_proposals';

function toChangeProposal(row: Record<string, unknown>): ChangeProposal {
  return {
    id: String(row.id),
    organizationId: String(row.organizationId ?? row.organization_id ?? DEFAULT_ORG),
    analysisRunKey: String(row.analysisRunKey ?? row.analysis_run_key ?? ""),
    messageId: (row.messageId ?? row.message_id ?? null) as string | null,
    entityId: String(row.entityId ?? row.entity_id ?? ""),
    proposalType: (row.proposalType ?? row.proposal_type ?? "ETA_CHANGE") as ProposalType,
    payload: (row.payload ?? {}) as ChangeProposal["payload"],
    evidence: (row.evidence ?? {}) as Readonly<Record<string, unknown>>,
    reviewState: String(row.reviewState ?? row.review_state ?? "REQUIRES_REVIEW"),
    baselineRevision: String(row.baselineRevision ?? row.baseline_revision ?? ""),
    status: (row.status ?? "PENDING") as ProposalStatus,
    sourceRecordId: String(row.sourceRecordId ?? row.source_record_id ?? ""),
    sourceType: String(row.sourceType ?? row.source_type ?? "supplier_message"),
    createdAt: toIsoOrNull(row.createdAt ?? row.created_at) ?? new Date().toISOString(),
    reviewedAt: toIsoOrNull(row.reviewedAt ?? row.reviewed_at),
    reviewedBy: (row.reviewedBy ?? row.reviewed_by ?? null) as string | null,
    reviewedNote: (row.reviewedNote ?? row.reviewed_note ?? null) as string | null,
    appliedAt: toIsoOrNull(row.appliedAt ?? row.applied_at),
  };
}

/** Entity-scoped event stream: per-PO reads must use this, never allEvents(). */
async function entityEventsQuery(pool: Pool, entityId: string): Promise<Event[]> {
  const rows = await pool.query(`${selectEvents} where entity_id=$1 order by occurred_at,id`, [entityId]);
  return rows.rows.map(toCanonicalEvent);
}

async function lockPurchaseOrders(client: PoolClient, entityIds: readonly string[]): Promise<void> {
  // All event writers share these transaction locks; sorted IDs avoid batch deadlocks.
  for (const id of [...new Set(entityIds)].sort()) {
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`procurebrain:po:${id}`]);
  }
}

async function persistSourceRecord(client: PoolClient, id: string, content: string, sourceType: string, organizationId: string, metadata: unknown): Promise<void> {
  await client.query("insert into source_records(id,source_type,content,organization_id,metadata,imported_at) values($1,$2,$3,$4,$5,now()) on conflict(id) do nothing", [id, sourceType, content, organizationId, metadata]);
  const stored = await client.query('select content, source_type as "sourceType" from source_records where id=$1', [id]);
  if (!stored.rows[0]) throw new Error("Source record was not persisted");
  assertSourceIdentity(stored.rows[0], content, sourceType, id);
}

function toSupplier(row: Record<string, unknown>): Supplier {
  return {
    id: String(row.id),
    organizationId: String(row.organizationId ?? row.organization_id ?? DEFAULT_ORG),
    supplierCode: String(row.supplierCode ?? row.supplier_code ?? ""),
    name: String(row.name ?? ""),
    primaryEmail: (row.primaryEmail ?? row.primary_email ?? null) as string | null,
    emailDomain: (row.emailDomain ?? row.email_domain ?? null) as string | null,
    phone: (row.phone ?? null) as string | null,
    country: (row.country ?? null) as string | null,
    currency: (row.currency ?? null) as string | null,
    defaultPaymentTerms: (row.defaultPaymentTerms ?? row.default_payment_terms ?? null) as string | null,
    status: String(row.status ?? "active"),
  };
}

function toIsoOrNull(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string" && value) return value;
  return null;
}

function toStringArrayOrNull(value: unknown): readonly string[] | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function toSupplierMessage(row: Record<string, unknown>): SupplierMessage {
  return {
    id: String(row.id),
    organizationId: String(row.organizationId ?? row.organization_id ?? DEFAULT_ORG),
    supplierId: (row.supplierId ?? row.supplier_id ?? null) as string | null,
    sourceRecordId: String(row.sourceRecordId ?? row.source_record_id ?? row.id),
    channel: String(row.channel ?? "supplier_message"),
    externalMessageId: (row.externalMessageId ?? row.external_message_id ?? null) as string | null,
    threadId: (row.threadId ?? row.thread_id ?? null) as string | null,
    sender: (row.sender ?? null) as string | null,
    recipients: toStringArrayOrNull(row.recipients),
    subject: (row.subject ?? null) as string | null,
    text: String(row.text ?? row.text_content ?? ""),
    sentAt: toIsoOrNull(row.sentAt ?? row.sent_at),
    receivedAt: toIsoOrNull(row.receivedAt ?? row.received_at) ?? new Date().toISOString(),
    processingStatus: (row.processingStatus ?? row.processing_status ?? "RECEIVED") as MessageStatus,
    proposalRunKey: (row.proposalRunKey ?? row.proposal_run_key ?? null) as string | null,
    createdAt: toIsoOrNull(row.createdAt ?? row.created_at) ?? new Date().toISOString(),
  };
}

function approvedEtaEventId(input: ApprovedEtaChange): string {
  return `approval-${createHash("sha256").update(JSON.stringify([input.approvalId, input.entityId, input.eta])).digest("hex")}`;
}

function approvedQuantityEventId(input: ApprovedQuantityChange): string {
  return `approval-qty-${createHash("sha256").update(JSON.stringify([input.approvalId, input.entityId, input.quantity])).digest("hex")}`;
}

function approvedQuantityEvent(input: ApprovedQuantityChange, current: PurchaseOrderState): Event {
  const eventType: "SUPPLIER_QUANTITY_CONFIRMED" | "SUPPLIER_QUANTITY_REDUCED" =
    current.confirmedQuantity === null && current.reducedQuantity === null ? "SUPPLIER_QUANTITY_CONFIRMED" : "SUPPLIER_QUANTITY_REDUCED";
  const value = {
    entityId: input.entityId,
    entityType: "PURCHASE_ORDER" as const,
    eventType,
    occurredAt: new Date(Math.max(Date.parse(input.approvedAt), current.lastOccurredAt ? Date.parse(current.lastOccurredAt) + 1 : 0)).toISOString(),
    sourceRecordId: input.sourceRecordId,
    payload: { quantity: input.quantity },
  };
  return {
    ...value,
    id: approvedQuantityEventId(input),
    ingestedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

function approvedEtaEvent(input: ApprovedEtaChange, current: PurchaseOrderState): Event {
  const eventType: "SUPPLIER_ETA_CONFIRMED" | "SUPPLIER_ETA_CHANGED" = current.eta === null ? "SUPPLIER_ETA_CONFIRMED" : "SUPPLIER_ETA_CHANGED";
  const value = {
    entityId: input.entityId,
    entityType: "PURCHASE_ORDER" as const,
    eventType,
    // Approval updates current state, even when an imported event has a future timestamp.
    occurredAt: new Date(Math.max(Date.parse(input.approvedAt), current.lastOccurredAt ? Date.parse(current.lastOccurredAt) + 1 : 0)).toISOString(),
    sourceRecordId: input.sourceRecordId,
    payload: { eta: input.eta },
  };
  return {
    ...value,
    id: approvedEtaEventId(input),
    ingestedAt: new Date().toISOString(),
    schemaVersion: 1,
  };
}

function normalizeImportCsv(csv: string, sourceRecordId: string, refs: readonly PurchaseOrderReference[], sourceType = "supplier_updates"): NormalizationResult {
  const result = sourceType === "purchase_orders"
    ? normalizePurchaseOrdersCsv(csv, sourceRecordId, refs)
    : normalizeCsv(csv, sourceRecordId, refs);
  return requireKnownPurchaseOrders(result, refs, sourceType);
}

function normalizeImportRows(rows: readonly InputRow[], sourceRecordId: string, refs: readonly PurchaseOrderReference[], sourceType = "supplier_updates"): NormalizationResult {
  if (sourceType === "purchase_orders") {
    const csv = rowsToCsv(rows);
    return requireKnownPurchaseOrders(normalizePurchaseOrdersCsv(csv, sourceRecordId, refs), refs, sourceType);
  }
  return requireKnownPurchaseOrders(normalizeRows(rows, sourceRecordId, refs), refs, sourceType);
}

function rowsToCsv(rows: readonly InputRow[]): string {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row.values)))];
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  return [headers, ...rows.map((row) => headers.map((header) => row.values[header] ?? ""))]
    .map((cells) => cells.map((cell) => quote(String(cell))).join(","))
    .join("\n");
}

/** The event-import route may update known orders; only the dedicated PO route may create unknown ones. */
function requireKnownPurchaseOrders(result: NormalizationResult, refs: readonly PurchaseOrderReference[], sourceType: string): NormalizationResult {
  if (sourceType === "purchase_orders") return result;
  const knownEntities = new Set(refs.map((reference) => reference.entityId));
  const accepted = result.events.filter((event) => event.eventType !== "PO_CREATED" || knownEntities.has(event.entityId));
  const createdUnknown = result.events.filter((event) => event.eventType === "PO_CREATED" && !knownEntities.has(event.entityId));
  const unresolved = createdUnknown.map((event, index) => {
    const payload = event.payload as { lineItems?: Array<{ poReference?: string }> };
    const reference = payload.lineItems?.[0]?.poReference ?? event.entityId;
    return { row: index + 2, code: "MALFORMED" as const, message: `PO ${reference} is unknown; create it through the purchase-order import`, resolution: { status: "UNRESOLVED" as const, reference, reason: "UNKNOWN_PO" as const } };
  });
  return { ...result, events: accepted, unresolved: [...result.unresolved, ...unresolved] };
}

function toCanonicalEvent(row: Record<string, unknown>): Event {
  return {
    ...row,
    occurredAt: toIsoTimestamp(row.occurredAt, "occurredAt"),
    ingestedAt: toIsoTimestamp(row.ingestedAt, "ingestedAt"),
  } as Event;
}

function toIsoTimestamp(value: unknown, field: string): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) throw new TypeError(`Invalid PostgreSQL ${field} timestamp`);
  return date.toISOString();
}
