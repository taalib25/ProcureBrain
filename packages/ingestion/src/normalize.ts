import type { Event, EventPayloadByType } from "../../domain/src/events";
import { parseCsv, normalizeHeader } from "./csv";
import { canonicalEventId } from "./idempotency";
import { normalizePoReference, resolvePurchaseOrder } from "./entity-resolution";
import type { InputRow, NormalizationIssue, NormalizationResult, PurchaseOrderReference } from "./types";

const aliases: Readonly<Record<string, readonly string[]>> = {
  po: ["po", "po_number", "purchase_order", "purchase_order_number", "purchase_order_id", "order_number"],
  event: ["event_type", "type", "kind", "record_type", "update_type"],
  date: ["occurred_at", "date", "event_date", "timestamp", "order_date", "created_at"],
  quantity: ["quantity", "ordered_quantity", "ordered_qty", "confirmed_quantity", "received_quantity", "qty"],
  supplierName: ["supplier", "supplier_name", "vendor", "vendor_name"],
  supplierId: ["supplier_id", "vendor_id"],
  eta: ["eta", "eta_date", "expected_delivery_date", "delivery_date"],
};

function value(row: InputRow, ...names: string[]): string | undefined {
  return names.map((name) => row.values[normalizeHeader(name)]).find((item) => item !== undefined && item.trim() !== "")?.trim();
}
function aliased(row: InputRow, key: keyof typeof aliases): string | undefined { return value(row, ...aliases[key]); }

function validDate(raw: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(raw)) return false;
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(raw.slice(0, 10));
}
function quantity(raw: string | undefined, row: InputRow, rejected: NormalizationIssue[]): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) { rejected.push({ row: row.row, code: "MALFORMED", message: `Invalid numeric value: ${raw}` }); return undefined; }
  const number = Number(raw);
  if (!Number.isFinite(number)) { rejected.push({ row: row.row, code: "MALFORMED", message: `Invalid numeric value: ${raw}` }); return undefined; }
  if (number < 0) { rejected.push({ row: row.row, code: "NEGATIVE_VALUE", message: "Quantities cannot be negative" }); return undefined; }
  return number;
}
function eventFor(row: InputRow, sourceRecordId: string, entityId: string, eventType: Event["eventType"], occurredAt: string, payload: EventPayloadByType[Event["eventType"]]): Event {
  const input = { sourceRecordId, entityId, eventType, occurredAt, payload };
  return { ...input, id: canonicalEventId(input), ingestedAt: new Date().toISOString(), entityType: "PURCHASE_ORDER", schemaVersion: 1 } as Event;
}

function normalize(rows: readonly InputRow[], sourceRecordId: string, purchaseOrders: readonly PurchaseOrderReference[], mode: "events" | "purchase-orders"): NormalizationResult {
  const events: Event[] = [], unresolved: Array<NormalizationResult["unresolved"][number]> = [], rejected: NormalizationIssue[] = [];
  for (const row of rows) {
    const po = aliased(row, "po");
    if (!po) { rejected.push({ row: row.row, code: "MISSING_PO", message: "Purchase-order reference is required" }); continue; }
    const kind = (aliased(row, "event") ?? "").toUpperCase().replace(/[ -]+/g, "_");
    const rawDate = aliased(row, "date");
    if (rawDate !== undefined && !validDate(rawDate)) { rejected.push({ row: row.row, code: "INVALID_DATE", message: `Invalid date: ${rawDate}` }); continue; }
    if (!rawDate) { rejected.push({ row: row.row, code: "INVALID_DATE", message: "An occurred/order date is required; no epoch fallback is applied" }); continue; }
    const occurredAt = new Date(rawDate).toISOString();
    const rawQuantity = aliased(row, "quantity");
    const countBefore = rejected.length;
    const qty = quantity(rawQuantity, row, rejected);
    if (rejected.length !== countBefore) continue;

    const isCreation = mode === "purchase-orders" || ["PO_CREATED", "NEW_PO", "NEW_ORDER", "NEW_COMMITMENT", "PURCHASE_ORDER"].includes(kind);
    const resolution = resolvePurchaseOrder(po, purchaseOrders);
    if (resolution.status !== "RESOLVED" && !isCreation) {
      unresolved.push({ row: row.row, code: "MALFORMED", message: `PO ${po} was not resolved; update was not attached`, resolution });
      continue;
    }
    const entityId = resolution.status === "RESOLVED" ? resolution.entityId : `po_${normalizePoReference(po).toLowerCase()}`;
    let eventType: Event["eventType"], payload: Record<string, unknown>;
    if (isCreation) {
      eventType = "PO_CREATED";
      payload = {
        ...(aliased(row, "supplierId") ? { supplierId: aliased(row, "supplierId") } : {}),
        ...(aliased(row, "supplierName") ? { supplierName: aliased(row, "supplierName") } : {}),
        ...(qty === undefined ? {} : { quantity: qty }),
        ...(aliased(row, "eta") ? { expectedDeliveryDate: aliased(row, "eta") } : {}),
        // Evidence is the canonicalized source row, retained for audit/replay without model interpretation.
        lineItems: [{ poReference: po, row: Object.fromEntries(Object.entries(row.values).map(([key, val]) => [normalizeHeader(key), val])) }],
      };
    } else {
      switch (kind) {
        case "SUPPLIER_UPDATE": case "ETA": case "ETA_CONFIRMED":
          if (!aliased(row, "eta") || !validDate(aliased(row, "eta")!)) { rejected.push({ row: row.row, code: "INVALID_DATE", message: "A valid ETA date is required for supplier ETA updates" }); continue; }
          eventType = kind === "ETA_CONFIRMED" ? "SUPPLIER_ETA_CONFIRMED" : "SUPPLIER_ETA_CHANGED"; payload = { eta: aliased(row, "eta")! }; break;
        case "RECEIPT": case "GOODS_RECEIVED":
          if (qty === undefined) { rejected.push({ row: row.row, code: "MALFORMED", message: "A quantity is required for goods receipts" }); continue; }
          eventType = "GOODS_RECEIVED"; payload = { ...(qty === undefined ? {} : { quantity: qty }), ...(value(row, "received_at") ? { receivedAt: value(row, "received_at") } : {}) }; break;
        case "FOLLOW_UP": case "FOLLOWUP": case "FOLLOWUP_SENT":
          eventType = "FOLLOWUP_SENT"; payload = { ...(value(row, "channel") ? { channel: value(row, "channel") } : {}), ...(value(row, "message") ? { message: value(row, "message") } : {}) }; break;
        case "QUANTITY_CONFIRMED": if (qty === undefined) { rejected.push({ row: row.row, code: "MALFORMED", message: "A quantity is required" }); continue; } eventType = "SUPPLIER_QUANTITY_CONFIRMED"; payload = { quantity: qty }; break;
        case "QUANTITY_REDUCED": if (qty === undefined) { rejected.push({ row: row.row, code: "MALFORMED", message: "A quantity is required" }); continue; } eventType = "SUPPLIER_QUANTITY_REDUCED"; payload = { quantity: qty }; break;
        case "SUPPLIER_RESPONSE": case "RESPONSE": eventType = "SUPPLIER_RESPONSE_RECEIVED"; payload = { ...(value(row, "response") ? { response: value(row, "response") } : {}), ...(value(row, "status") ? { status: value(row, "status") } : {}) }; break;
        default: rejected.push({ row: row.row, code: "UNKNOWN_EVENT", message: `Unsupported event type: ${kind || "empty"}` }); continue;
      }
    }
    events.push(eventFor(row, sourceRecordId, entityId, eventType!, occurredAt, payload as never));
  }
  return { events, unresolved, rejected };
}

export function normalizeRows(rows: readonly InputRow[], sourceRecordId: string, purchaseOrders: readonly PurchaseOrderReference[]): NormalizationResult {
  return normalize(rows, sourceRecordId, purchaseOrders, "events");
}

export function normalizeCsv(csv: string, sourceRecordId: string, purchaseOrders: readonly PurchaseOrderReference[]): NormalizationResult {
  const rows = parseCsv(csv);
  const headers = rows[0] ? Object.keys(rows[0].values) : [];
  if (!headers.some((header) => aliases.po.includes(normalizeHeader(header)))) {
    return { events: [], unresolved: [], rejected: [{ row: 1, code: "MISSING_HEADERS", message: "Required purchase-order reference header is missing" }] };
  }
  return normalize(rows, sourceRecordId, purchaseOrders, "events");
}

/** Normalize a purchase_orders.csv upload. Every data row is a PO creation, regardless of whether
 * it already exists in the supplied reference set; stable event identity makes reimports idempotent.
 * A source order/creation date is required because canonical events require operational time. */
export function normalizePurchaseOrdersCsv(csv: string, sourceRecordId: string, purchaseOrders: readonly PurchaseOrderReference[] = []): NormalizationResult {
  const rows = parseCsv(csv);
  const headers = rows[0] ? Object.keys(rows[0].values) : [];
  if (!headers.some((header) => aliases.po.includes(normalizeHeader(header)))) {
    return { events: [], unresolved: [], rejected: [{ row: 1, code: "MISSING_HEADERS", message: "Required purchase-order reference header is missing" }] };
  }
  return normalize(rows, sourceRecordId, purchaseOrders, "purchase-orders");
}
