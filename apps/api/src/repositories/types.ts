import type { Event } from "../../../../packages/domain/src/events";
import type { ProcurementException } from "../../../../packages/domain/src/exceptions";
import type { PurchaseOrderState } from "../../../../packages/domain/src/purchase-order";
import type { InputRow, PurchaseOrderReference } from "../../../../packages/ingestion/src";
import type { ApplyEtaResult, ApprovedEtaChange, ApprovedQuantityChange, ApplyQuantityResult, ChangeProposal, ImportResult, MessageCandidate, MessageStatus, NewChangeProposal, NewSupplier, NewSupplierMessage, ProposalStatus, Supplier, SupplierMessage } from "../store";

/** Sync memory stores and async Postgres stores both satisfy these seams. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * Purchase-order read and write surface used by HTTP routes.
 * Per-PO reads must be entity-scoped (no full event-stream scans);
 * exceptions() intentionally still reads the whole stream until the
 * purchase-order projection ticket lands (plan 7.5).
 * Identity reads accept an optional organization; event streams stay
 * organization-agnostic until full tenant boundaries land.
 */
export interface PurchaseOrderRepository {
  purchaseOrders(organizationId?: string): MaybePromise<PurchaseOrderState[]>;
  state(id: string): MaybePromise<PurchaseOrderState | undefined>;
  timeline(id: string): MaybePromise<Event[]>;
  exceptions(): MaybePromise<ProcurementException[]>;
  purchaseOrderReference(entityId: string, organizationId?: string): MaybePromise<PurchaseOrderReference | undefined>;
  purchaseOrderReferences(organizationId?: string): MaybePromise<PurchaseOrderReference[]>;
  allEvents(): MaybePromise<readonly Event[]>;
  importCsv(csv: string, sourceRecordId: string, sourceType?: string, organizationId?: string): MaybePromise<ImportResult>;
  importRows(rows: readonly InputRow[], sourceRecordId: string, sourceType?: string, organizationId?: string): MaybePromise<ImportResult>;
  applyApprovedEtaChange(input: ApprovedEtaChange): MaybePromise<ApplyEtaResult>;
  suppliers(organizationId: string): MaybePromise<Supplier[]>;
  supplier(id: string, organizationId?: string): MaybePromise<Supplier | undefined>;
  createSupplier(input: NewSupplier, organizationId: string): MaybePromise<Supplier>;
  supplierPurchaseOrders(supplierId: string, organizationId: string): MaybePromise<PurchaseOrderState[]>;
  createMessage(input: NewSupplierMessage, organizationId: string): MaybePromise<{ status: "created" | "existing"; message: SupplierMessage }>;
  getMessage(id: string, organizationId: string): MaybePromise<SupplierMessage | undefined>;
  listMessages(organizationId: string): MaybePromise<SupplierMessage[]>;
  saveMessageCandidates(messageId: string, candidates: ReadonlyArray<{ entityId: string; matchMethod: MessageCandidate["matchMethod"]; matchScore?: number | null }>, selectedEntityId?: string): MaybePromise<MessageCandidate[]>;
  getMessageCandidates(messageId: string): MaybePromise<MessageCandidate[]>;
  setMessageStatus(id: string, status: MessageStatus, patch?: { supplierId?: string | null; proposalRunKey?: string | null }): MaybePromise<SupplierMessage | undefined>;
  ensureProposal(input: NewChangeProposal): MaybePromise<{ status: "created" | "existing"; proposal: ChangeProposal }>;
  getProposal(id: string, organizationId: string): MaybePromise<ChangeProposal | undefined>;
  getProposalByRunKey(analysisRunKey: string, organizationId: string): MaybePromise<ChangeProposal | undefined>;
  listProposals(organizationId: string): MaybePromise<ChangeProposal[]>;
  transitionProposal(id: string, organizationId: string, to: ProposalStatus, patch?: { reviewedBy?: string; reviewedNote?: string }): MaybePromise<{ status: "ok" | "not_found" | "illegal"; proposal?: ChangeProposal }>;
  applyApprovedQuantityChange(input: ApprovedQuantityChange): MaybePromise<ApplyQuantityResult>;
}
