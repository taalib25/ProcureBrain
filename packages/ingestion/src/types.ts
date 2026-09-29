import type { EventType, Event } from "../../domain/src/events";

export interface SourceRecord {
  readonly id: string;
  readonly sourceType: string;
  readonly sourceName?: string;
  readonly importedAt: string;
  readonly content: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface PurchaseOrderReference {
  readonly entityId: string;
  readonly poNumber: string;
  readonly aliases?: readonly string[];
}

export type Resolution =
  | { readonly status: "RESOLVED"; readonly entityId: string; readonly matchedBy: "EXACT" | "NORMALIZED" }
  | { readonly status: "UNRESOLVED"; readonly reference: string; readonly reason: "UNKNOWN_PO" | "AMBIGUOUS_PO" };

export interface NormalizationIssue {
  readonly row: number;
  readonly code: "MALFORMED" | "NEGATIVE_VALUE" | "MISSING_PO" | "UNKNOWN_EVENT" | "MISSING_HEADERS" | "INVALID_DATE";
  readonly message: string;
}

export interface NormalizationResult {
  readonly events: readonly Event[];
  readonly unresolved: readonly (NormalizationIssue & { readonly resolution: Resolution })[];
  readonly rejected: readonly NormalizationIssue[];
}

export interface InputRow {
  readonly row: number;
  readonly values: Readonly<Record<string, string>>;
}

export interface EventInput {
  readonly sourceRecordId: string;
  readonly entityId: string;
  readonly eventType: EventType;
  readonly occurredAt: string;
  readonly payload: unknown;
}
