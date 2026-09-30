import { detectExceptions } from "../../../packages/domain/src/exceptions";
import { replayPurchaseOrder } from "../../../packages/domain/src/reducer";
import type { PurchaseOrderState } from "../../../packages/domain/src/purchase-order";
import { sortExceptions } from "../../../packages/domain/src/priority";
import type { Event } from "../../../packages/domain/src/events";
import { normalizeCsv, normalizePurchaseOrdersCsv, normalizeRows, type InputRow, type NormalizationResult, type PurchaseOrderReference } from "../../../packages/ingestion/src";
import { canonicalEventId, idempotencyKey } from "../../../packages/ingestion/src/idempotency";
import type { Pool } from "pg";

export interface ImportResult { sourceRecordId: string; inserted: number; events: readonly Event[]; unresolved: readonly unknown[]; rejected: readonly unknown[] }
export interface ApprovedEtaChange {
  entityId: string;
  expectedEta: string | null;
  eta: string;
  occurredAt: string;
  sourceRecordId: string;
  sourceText: string;
}
export type ApplyEtaResult =
  | { status: "applied"; event: Event }
  | { status: "already_applied"; event: Event }
  | { status: "stale"; currentEta: string | null }
  | { status: "unchanged" }
  | { status: "unknown_po" };

const initialReferences: PurchaseOrderReference[] = [
  { entityId: "po-1", poNumber: "PO-1001", aliases: ["1001"] },
  { entityId: "po-2", poNumber: "PO-1002", aliases: ["1002"] },
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
  private readonly sourceRecords = new Map<string, { id: string; content: string; sourceType: string; importedAt: string }>();
  private references: PurchaseOrderReference[] = [...initialReferences];

  importCsv(csv: string, sourceRecordId: string, _sourceType?: string): ImportResult {
    const result = normalizeImportCsv(csv, sourceRecordId, this.references, _sourceType);
    return this.add(result.events, sourceRecordId, result.unresolved, result.rejected, csv, _sourceType ?? "supplier_updates");
  }

  importRows(rows: Parameters<typeof normalizeRows>[0], sourceRecordId: string, _sourceType?: string): ImportResult {
    const result = normalizeImportRows(rows, sourceRecordId, this.references, _sourceType);
    return this.add(result.events, sourceRecordId, result.unresolved, result.rejected, JSON.stringify(rows), _sourceType ?? "supplier_updates");
  }

  private add(events: readonly Event[], sourceRecordId: string, unresolved: readonly unknown[], rejected: readonly unknown[], content: string, sourceType: string): ImportResult {
    if (!this.sourceRecords.has(sourceRecordId)) this.sourceRecords.set(sourceRecordId, { id: sourceRecordId, content, sourceType, importedAt: new Date().toISOString() });
    const ids = new Set(this.events.map((event) => event.id));
    const fresh = events.filter((event) => !ids.has(event.id));
    this.events.push(...fresh);
    for (const event of fresh) if (event.eventType === "PO_CREATED" && !this.references.some((po) => po.entityId === event.entityId)) {
      const lineItems = event.payload.lineItems as Array<{ poReference?: string }> | undefined;
      const poNumber = String(lineItems?.[0]?.poReference ?? event.entityId.replace(/^po_/, ""));
      this.references.push({ entityId: event.entityId, poNumber });
    }
    return { sourceRecordId, inserted: fresh.length, events: fresh, unresolved, rejected };
  }

  allEvents(): readonly Event[] { return this.events; }
  sources() { return [...this.sourceRecords.values()].map(({ content: _content, ...record }) => record); }
  source(id: string) { return this.sourceRecords.get(id); }
  purchaseOrderReference(entityId: string): PurchaseOrderReference | undefined { return this.references.find((reference) => reference.entityId === entityId); }
  applyApprovedEtaChange(input: ApprovedEtaChange): ApplyEtaResult {
    const current = this.state(input.entityId);
    if (!current || !this.purchaseOrderReference(input.entityId)) return { status: "unknown_po" };
    if (current.eta !== input.expectedEta) return { status: "stale", currentEta: current.eta };
    if (current.eta === input.eta) return { status: "unchanged" };
    const event = approvedEtaEvent(input, current.eta);
    const existing = this.events.find((item) => item.id === event.id);
    if (existing) return { status: "already_applied", event: existing };
    if (!this.sourceRecords.has(input.sourceRecordId)) this.sourceRecords.set(input.sourceRecordId, {
      id: input.sourceRecordId,
      content: input.sourceText,
      sourceType: "supplier_message",
      importedAt: new Date().toISOString(),
    });
    this.events.push(event);
    return { status: "applied", event };
  }
  purchaseOrders(): PurchaseOrderState[] {
    return this.references.map(({ entityId }) => replayPurchaseOrder(this.events.filter((event) => event.entityId === entityId), entityId));
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

  private async references(): Promise<PurchaseOrderReference[]> {
    const result = await this.pool.query("select entity_id, po_number from purchase_orders");
    return result.rows.map((row) => ({ entityId: row.entity_id, poNumber: row.po_number }));
  }

  async importCsv(csv: string, sourceRecordId: string, sourceType = "supplier_updates") {
    const refs = await this.references();
    const normalized = normalizeImportCsv(csv, sourceRecordId, refs, sourceType);
    return this.persist(normalized.events, sourceRecordId, csv, sourceType, normalized.unresolved, normalized.rejected);
  }

  async importRows(rows: Parameters<typeof normalizeRows>[0], sourceRecordId: string, sourceType = "supplier_updates") {
    const refs = await this.references();
    const normalized = normalizeImportRows(rows, sourceRecordId, refs, sourceType);
    return this.persist(normalized.events, sourceRecordId, JSON.stringify(rows), sourceType, normalized.unresolved, normalized.rejected);
  }

  private async persist(events: readonly Event[], id: string, content: string, sourceType: string, unresolved: readonly unknown[], rejected: readonly unknown[]) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query("insert into source_records(id,source_type,content,metadata,imported_at) values($1,$2,$3,$4,now()) on conflict(id) do nothing", [id, sourceType, content, { rowCount: events.length }]);
      let inserted = 0;
      const newlyInserted: Event[] = [];
      for (const event of events) {
        if (event.eventType === "PO_CREATED") {
          const reference = (event.payload.lineItems as Array<{ poReference?: string }> | undefined)?.[0]?.poReference ?? event.entityId;
          await client.query("insert into purchase_orders(entity_id,po_number,supplier_id,supplier_name) values($1,$2,$3,$4) on conflict(entity_id) do nothing", [event.entityId, reference, event.payload.supplierId ?? null, event.payload.supplierName ?? null]);
        }
        const key = idempotencyKey({ sourceRecordId: event.sourceRecordId, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
        const result = await client.query("insert into canonical_events(id,idempotency_key,entity_type,entity_id,event_type,occurred_at,ingested_at,source_record_id,payload,schema_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing", [event.id,key,event.entityType,event.entityId,event.eventType,event.occurredAt,event.ingestedAt,id,event.payload,event.schemaVersion]);
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
  async source(id: string) { return (await this.pool.query("select id,source_type as \"sourceType\",source_name as \"sourceName\",content,metadata,imported_at as \"importedAt\" from source_records where id=$1", [id])).rows[0]; }
  async sources() { return (await this.pool.query("select id,source_type as \"sourceType\",source_name as \"sourceName\",metadata,imported_at as \"importedAt\" from source_records order by imported_at desc")).rows; }
  async purchaseOrderReference(entityId: string): Promise<PurchaseOrderReference | undefined> {
    const row = (await this.pool.query("select entity_id, po_number from purchase_orders where entity_id=$1", [entityId])).rows[0];
    return row ? { entityId: String(row.entity_id), poNumber: String(row.po_number) } : undefined;
  }
  async applyApprovedEtaChange(input: ApprovedEtaChange): Promise<ApplyEtaResult> {
    const current = await this.state(input.entityId);
    if (!current || !await this.purchaseOrderReference(input.entityId)) return { status: "unknown_po" };
    if (current.eta !== input.expectedEta) return { status: "stale", currentEta: current.eta };
    if (current.eta === input.eta) return { status: "unchanged" };
    const event = approvedEtaEvent(input, current.eta);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "insert into source_records(id,source_type,content,metadata,imported_at) values($1,'supplier_message',$2,$3,now()) on conflict(id) do nothing",
        [input.sourceRecordId, input.sourceText, { approved: true }],
      );
      const key = idempotencyKey({ sourceRecordId: event.sourceRecordId, entityId: event.entityId, eventType: event.eventType, occurredAt: event.occurredAt, payload: event.payload });
      const inserted = await client.query(
        "insert into canonical_events(id,idempotency_key,entity_type,entity_id,event_type,occurred_at,ingested_at,source_record_id,payload,schema_version) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict do nothing returning id",
        [event.id, key, event.entityType, event.entityId, event.eventType, event.occurredAt, event.ingestedAt, event.sourceRecordId, event.payload, event.schemaVersion],
      );
      await client.query("commit");
      return inserted.rowCount ? { status: "applied", event } : { status: "already_applied", event };
    } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
  }
  async analysisRuns() { return (await this.pool.query("select * from analysis_runs order by created_at desc limit 100")).rows; }
  async purchaseOrders() { const events = await this.allEvents(); return (await this.references()).map(({ entityId }) => replayPurchaseOrder(events.filter((event) => event.entityId === entityId), entityId)); }
  async state(id: string) { const events = (await this.allEvents()).filter((event) => event.entityId === id); return events.length ? replayPurchaseOrder(events, id) : undefined; }
  async timeline(id: string) { return (await this.allEvents()).filter((event) => event.entityId === id); }
  async exceptions() { return sortExceptions(detectExceptions(await this.allEvents(), { now: new Date().toISOString() })); }
}

function approvedEtaEvent(input: ApprovedEtaChange, previousEta: string | null): Event {
  const eventType: "SUPPLIER_ETA_CONFIRMED" | "SUPPLIER_ETA_CHANGED" = previousEta === null ? "SUPPLIER_ETA_CONFIRMED" : "SUPPLIER_ETA_CHANGED";
  const value = {
    entityId: input.entityId,
    entityType: "PURCHASE_ORDER" as const,
    eventType,
    occurredAt: input.occurredAt,
    sourceRecordId: input.sourceRecordId,
    payload: { eta: input.eta },
  };
  return {
    ...value,
    id: canonicalEventId(value),
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
