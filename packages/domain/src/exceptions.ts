import { sortEvents, type Event } from "./events";
import { replayPurchaseOrder } from "./reducer";
import type { PurchaseOrderState } from "./purchase-order";
import { priorityForException } from "./priority";

export const EXCEPTION_TYPES = [
  "ETA_CHANGED",
  "LATE_PO",
  "QUANTITY_SHORT",
  "RECEIPT_SHORT",
  "FOLLOWUP_OVERDUE",
] as const;

export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

export interface ProcurementException {
  readonly id: string;
  readonly type: ExceptionType;
  readonly entityType: "PURCHASE_ORDER";
  readonly entityId: string;
  readonly priority: number;
  readonly eventIds: readonly string[];
  readonly sourceRecordIds: readonly string[];
  readonly details: Readonly<Record<string, string | number>>;
}

export interface ExceptionOptions {
  /** Operational clock used by LATE_PO and FOLLOWUP_OVERDUE. Defaults to the latest event time. */
  readonly now?: string | Date;
  /** Follow-up age in milliseconds. Defaults to seven days. */
  readonly followupThresholdMs?: number;
  /** Alias useful to callers expressing the threshold in days. */
  readonly followupThresholdDays?: number;
}

const DEFAULT_FOLLOWUP_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function timestamp(value: string | Date | undefined, fallback: string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string" && validDate(value)) return Date.parse(value);
  return Date.parse(fallback);
}

function validQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function evidence(events: readonly Event[]): Pick<ProcurementException, "eventIds" | "sourceRecordIds"> {
  return {
    eventIds: events.map((event) => event.id),
    sourceRecordIds: events.map((event) => event.sourceRecordId),
  };
}

function makeException(
  type: ExceptionType,
  entityId: string,
  events: readonly Event[],
  details: Readonly<Record<string, string | number>> = {},
): ProcurementException {
  const ids = evidence(events);
  return {
    id: `${entityId}:${type}:${ids.eventIds.join(",")}`,
    type,
    entityType: "PURCHASE_ORDER",
    entityId,
    priority: priorityForException(type),
    ...ids,
    details,
  };
}

function createdEvents(events: readonly Event[]): Event[] {
  return events.filter((event) => event.eventType === "PO_CREATED");
}

function quantityEvents(events: readonly Event[]): Event[] {
  return events.filter(
    (event) =>
      (event.eventType === "SUPPLIER_QUANTITY_CONFIRMED" ||
        event.eventType === "SUPPLIER_QUANTITY_REDUCED") &&
      validQuantity(event.payload.quantity),
  );
}

function quantityFromEvent(event: Event | undefined): number | undefined {
  if (
    event?.eventType !== "SUPPLIER_QUANTITY_CONFIRMED" &&
    event?.eventType !== "SUPPLIER_QUANTITY_REDUCED"
  ) return undefined;
  return event.payload.quantity;
}

function receiptEvents(events: readonly Event[]): Event[] {
  return events.filter(
    (event) => event.eventType === "GOODS_RECEIVED" && validQuantity(event.payload.quantity ?? 0),
  );
}

function detectForPo(events: readonly Event[], options: ExceptionOptions, now: string): ProcurementException[] {
  const ordered = sortEvents(events);
  const created = createdEvents(ordered);
  // Unknown PO streams are not operational POs and must not create attention items.
  if (created.length === 0) return [];
  const entityId = ordered[0].entityId;
  const state = replayPurchaseOrder(ordered, entityId);
  const result: ProcurementException[] = [];

  let previousEta: string | null = null;
  for (const event of ordered) {
    if (event.eventType === "SUPPLIER_ETA_CONFIRMED" && validDate(event.payload.eta)) {
      previousEta = event.payload.eta;
    } else if (
      event.eventType === "SUPPLIER_ETA_CHANGED" &&
      validDate(event.payload.eta) &&
      previousEta !== null &&
      event.payload.eta !== previousEta
    ) {
      result.push(makeException("ETA_CHANGED", entityId, [event], {
        previousEta,
        newEta: event.payload.eta,
      }));
      previousEta = event.payload.eta;
    }
  }

  const eta = state.eta;
  if (validDate(eta) && timestamp(now, now) > Date.parse(eta) && state.status !== "RECEIVED") {
    const supporting = ordered.filter((event) =>
      (event.eventType === "PO_CREATED" && validDate(event.payload.expectedDeliveryDate)) ||
      ((event.eventType === "SUPPLIER_ETA_CONFIRMED" || event.eventType === "SUPPLIER_ETA_CHANGED") &&
        validDate(event.payload.eta)),
    );
    result.push(makeException("LATE_PO", entityId, supporting, { eta }));
  }

  const quantities = quantityEvents(ordered);
  const latestQuantity = quantities.at(-1);
  const orderedQuantity = state.orderedQuantity;
  const confirmedQuantity = quantityFromEvent(latestQuantity);
  if (
    validQuantity(orderedQuantity) &&
    validQuantity(confirmedQuantity) &&
    confirmedQuantity < orderedQuantity
  ) {
    result.push(makeException("QUANTITY_SHORT", entityId, [
      ...created,
      latestQuantity!,
    ], { orderedQuantity, confirmedQuantity }));
  }

  const receipts = receiptEvents(ordered);
  const expected = validQuantity(confirmedQuantity) ? confirmedQuantity : orderedQuantity;
  // A receipt cannot establish a shortfall until the expected quantity was known.
  const createdWithQuantity = created.find(
    (event) => event.eventType === "PO_CREATED" && validQuantity(event.payload.quantity),
  );
  const expectedEvent = latestQuantity ?? createdWithQuantity;
  const lastReceipt = receipts.at(-1);
  if (
    lastReceipt &&
    expectedEvent &&
    validQuantity(expected) &&
    Date.parse(lastReceipt.occurredAt) >= Date.parse(expectedEvent.occurredAt) &&
    state.receivedQuantity < expected
  ) {
    result.push(makeException("RECEIPT_SHORT", entityId, [expectedEvent, ...receipts], {
      expectedQuantity: expected,
      receivedQuantity: state.receivedQuantity,
    }));
  }

  const followups = ordered.filter((event) => event.eventType === "FOLLOWUP_SENT");
  const responses = ordered.filter((event) => event.eventType === "SUPPLIER_RESPONSE_RECEIVED");
  const latestFollowup = followups.at(-1);
  const latestResponse = responses.at(-1);
  const threshold = options.followupThresholdMs ??
    (options.followupThresholdDays !== undefined
      ? options.followupThresholdDays * 24 * 60 * 60 * 1000
      : DEFAULT_FOLLOWUP_THRESHOLD_MS);
  if (
    latestFollowup &&
    (!latestResponse || latestResponse.occurredAt < latestFollowup.occurredAt ||
      (latestResponse.occurredAt === latestFollowup.occurredAt && latestResponse.id < latestFollowup.id)) &&
    timestamp(now, now) - Date.parse(latestFollowup.occurredAt) >= threshold
  ) {
    result.push(makeException("FOLLOWUP_OVERDUE", entityId, [latestFollowup], {
      followupAt: latestFollowup.occurredAt,
      thresholdMs: threshold,
    }));
  }
  return result;
}

export function detectExceptions(
  events: readonly Event[],
  options: ExceptionOptions = {},
): ProcurementException[] {
  const sorted = sortEvents(events);
  // Event IDs are the idempotency key. Repeated deliveries must not duplicate evidence.
  const seen = new Set<string>();
  const ordered = sorted.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
  const fallback = ordered.at(-1)?.occurredAt ?? "1970-01-01T00:00:00.000Z";
  const now = options.now instanceof Date ? options.now.toISOString() : options.now ?? fallback;
  const entityIds = [...new Set(ordered.map((event) => event.entityId))].sort();
  return entityIds.flatMap((entityId) =>
    detectForPo(ordered.filter((event) => event.entityId === entityId), options, now),
  );
}

export const evaluateExceptions = detectExceptions;
export const EXCEPTION_RULES = EXCEPTION_TYPES;

export type { PurchaseOrderState };
