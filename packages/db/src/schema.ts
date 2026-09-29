import { jsonb, pgTable, text, timestamp, integer, uniqueIndex, customType } from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => "bytea" });

export const sourceRecords = pgTable("source_records", {
  id: text("id").primaryKey(),
  sourceType: text("source_type").notNull(),
  sourceName: text("source_name"),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull(),
});

export const canonicalEvents = pgTable("canonical_events", {
  id: text("id").primaryKey(),
  idempotencyKey: text("idempotency_key").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  eventType: text("event_type").notNull(),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull(),
  sourceRecordId: text("source_record_id").notNull().references(() => sourceRecords.id),
  payload: jsonb("payload").notNull(),
  schemaVersion: integer("schema_version").notNull(),
}, (table) => ({ idempotencyUnique: uniqueIndex("canonical_events_idempotency_key").on(table.idempotencyKey) }));

export const purchaseOrders = pgTable("purchase_orders", {
  entityId: text("entity_id").primaryKey(),
  poNumber: text("po_number").notNull(),
  supplierId: text("supplier_id"),
  supplierName: text("supplier_name"),
});

export const analysisInputs = pgTable("analysis_inputs", {
  hash: text("hash").primaryKey(),
  content: bytea("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const analysisRuns = pgTable("analysis_runs", {
  cacheKey: text("cache_key").primaryKey(),
  id: text("id").notNull(),
  inputHash: text("input_hash").notNull().references(() => analysisInputs.hash),
  request: jsonb("request").notNull(),
  status: text("status").notNull(),
  result: jsonb("result"),
  error: text("error"),
  modelRequest: jsonb("model_request"),
  modelResponse: jsonb("model_response"),
  usage: jsonb("usage"),
  fallbackTier: text("fallback_tier"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  ownerToken: text("owner_token"),
  leaseGeneration: integer("lease_generation").notNull().default(0),
});
