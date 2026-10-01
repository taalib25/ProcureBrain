import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { PostgresStore } from "../src/store";

describe("PostgresStore event mapping", () => {
  it("converts node-postgres timestamp Dates to canonical ISO strings before domain sorting", async () => {
    const databaseRows = [
      { id: "e1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: new Date("2025-03-01T12:00:00.000Z"), ingestedAt: new Date("2025-03-01T12:00:01.000Z"), sourceRecordId: "source-1", payload: { quantity: 2 }, schemaVersion: 1 },
      { id: "e2", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: new Date("2025-03-02T12:00:00.000Z"), ingestedAt: new Date("2025-03-02T12:00:01.000Z"), sourceRecordId: "source-1", payload: { quantity: 1 }, schemaVersion: 1 },
    ];
    const pool = { query: async () => ({ rows: databaseRows }) } as unknown as Pool;
    const events = await new PostgresStore(pool).timeline("po-1");

    expect(events.map((event) => event.occurredAt)).toEqual([
      "2025-03-01T12:00:00.000Z",
      "2025-03-02T12:00:00.000Z",
    ]);
    expect(events.every((event) => typeof event.ingestedAt === "string")).toBe(true);
  });

  it("uses purchase-order normalization and preserves source identity through PostgreSQL inserts", async () => {
    const queries: Array<{ sql: string; values?: unknown[] }> = [];
    const client = {
      query: async (sql: string, values?: unknown[]) => {
        queries.push({ sql, values });
        if (sql.startsWith("select content")) return { rowCount: 1, rows: [{ content: csv, sourceType: "purchase_orders" }] };
        return { rowCount: sql.includes("insert into canonical_events") ? 1 : 0, rows: [] };
      },
      release: () => undefined,
    };
    const pool = {
      query: async () => ({ rows: [] }),
      connect: async () => client,
    } as unknown as Pool;
    const csv = "po_number,supplier_name,order_date,quantity\nPO-PG-8,Parts Co,2025-06-04,5";
    const result = await new PostgresStore(pool).importCsv(csv, "source-po-8", "purchase_orders");

    expect(result.inserted).toBe(1);
    expect(result.events[0]?.eventType).toBe("PO_CREATED");
    expect(result.events[0]?.sourceRecordId).toBe("source-po-8");
    expect(queries.find(({ sql }) => sql.includes("insert into source_records"))?.values?.slice(0, 3)).toEqual(["source-po-8", "purchase_orders", csv]);
    expect(queries.find(({ sql }) => sql.includes("insert into canonical_events"))?.values?.[7]).toBe("source-po-8");
  });
});
