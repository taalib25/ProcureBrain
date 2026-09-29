import { describe, expect, it } from "vitest";
import { idempotencyKey, normalizeCsv, normalizePurchaseOrdersCsv, normalizeRows, parseCsv, resolvePurchaseOrder } from "../src/index";

const orders = [{ entityId: "po-1", poNumber: "PO-001" }];

describe("ingestion", () => {
  it("parses quoted CSV and normalizes supplier updates, receipts and follow-ups", () => {
    const csv = `po_number,event_type,eta,quantity,message,occurred_at\nPO-001,SUPPLIER_UPDATE,2026-10-01,,,2026-09-01\nPO-001,RECEIPT,,3,,2026-09-02\nPO-001,FOLLOW_UP,,,"Please confirm, thanks",2026-09-03`;
    const result = normalizeCsv(csv, "source-1", orders);
    expect(result.events).toHaveLength(3);
    expect(result.events.map((event) => event.eventType)).toEqual(["SUPPLIER_ETA_CHANGED", "GOODS_RECEIVED", "FOLLOWUP_SENT"]);
    expect(result.events[2].payload).toMatchObject({ message: "Please confirm, thanks" });
  });

  it("is stable for duplicate imports", () => {
    const rows = parseCsv("po_number,event_type,quantity,occurred_at\nPO-001,RECEIPT,2,2026-01-01T00:00:00Z");
    const first = normalizeRows(rows, "source-1", orders).events[0];
    const second = normalizeRows(rows, "source-1", orders).events[0];
    expect(second.id).toBe(first.id);
    expect(idempotencyKey({ ...({ sourceRecordId: "source-1", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: "2026-01-01T00:00:00Z", payload: { quantity: 2 } }) }))
      .toBe(idempotencyKey({ sourceRecordId: "source-2", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: "2026-01-01T00:00:00Z", payload: { quantity: 2 } }));
  });

  it("does not guess unknown or ambiguous purchase orders", () => {
    expect(resolvePurchaseOrder("PO-999", orders)).toMatchObject({ status: "UNRESOLVED", reason: "UNKNOWN_PO" });
    const result = normalizeCsv("po_number,event_type,quantity,occurred_at\nPO-999,RECEIPT,1,2026-01-01", "source-1", orders);
    expect(result.events).toHaveLength(0);
    expect(result.unresolved[0].resolution.status).toBe("UNRESOLVED");
  });

  it("rejects malformed and negative quantities", () => {
    const result = normalizeCsv("po_number,event_type,quantity,occurred_at\nPO-001,RECEIPT,-1,2026-01-01\nPO-001,RECEIPT,nope,2026-01-01", "source-1", orders);
    expect(result.events).toHaveLength(0);
    expect(result.rejected.map((item) => item.code)).toEqual(["NEGATIVE_VALUE", "MALFORMED"]);
  });

  it("creates deterministic PO_CREATED events for unknown creation references with supplier aliases and evidence", () => {
    const csv = "purchase order id,vendor,Vendor ID,ordered qty,delivery date,order date\nPO-77,Acme Ltd,S-77,4,2026-04-03,2026-03-01";
    const first = normalizePurchaseOrdersCsv(csv, "source-a", orders);
    const second = normalizePurchaseOrdersCsv(csv, "source-b", orders);
    expect(first.events[0]).toMatchObject({ eventType: "PO_CREATED", entityId: "po_po77", payload: { supplierName: "Acme Ltd", supplierId: "S-77", quantity: 4, expectedDeliveryDate: "2026-04-03", lineItems: [{ poReference: "PO-77" }] } });
    expect(second.events[0].id).toBe(first.events[0].id);
    expect(first.unresolved).toHaveLength(0);
  });

  it("does not turn an unknown supplier update into a creation or attach it to another PO", () => {
    const result = normalizeCsv("po_number,event_type,eta,occurred_at\nPO-999,SUPPLIER_UPDATE,2026-04-03,2026-04-01", "source", orders);
    expect(result.events).toHaveLength(0);
    expect(result.unresolved[0].resolution).toMatchObject({ status: "UNRESOLVED", reason: "UNKNOWN_PO" });
  });

  it("reports missing headers, invalid dates, and invalid quantities with input row numbers", () => {
    expect(normalizeCsv("event_type,quantity\nPO_CREATED,1", "s", orders).rejected[0].code).toBe("MISSING_HEADERS");
    const result = normalizeCsv("po_number,event_type,quantity,occurred_at\nPO-001,RECEIPT,1,not-a-date\nPO-001,RECEIPT,-2,2026-01-01", "s", orders);
    expect(result.rejected.map((issue) => [issue.row, issue.code])).toEqual([[2, "INVALID_DATE"], [3, "NEGATIVE_VALUE"]]);
  });

  it("normalizes late-arriving dated events consistently", () => {
    const older = normalizeCsv("po_number,event_type,quantity,occurred_at\nPO-001,RECEIPT,2,2026-01-01", "s1", orders).events[0];
    const laterImport = normalizeCsv("po_number,event_type,quantity,occurred_at\nPO-001,RECEIPT,3,2026-01-03", "s2", orders).events[0];
    expect(laterImport.occurredAt).toBe("2026-01-03T00:00:00.000Z");
    expect(laterImport.id).not.toBe(older.id);
  });

  it("imports ordinary purchase-order CSVs without event_type and creates known and new references", () => {
    const result = normalizePurchaseOrdersCsv("po_number,supplier_name,quantity,order_date\nPO-001,Existing Co,2,2026-01-01\nPO-NEW,New Co,5,2026-01-02", "upload", orders);
    expect(result.events.map((event) => event.eventType)).toEqual(["PO_CREATED", "PO_CREATED"]);
    expect(result.events[0].entityId).toBe("po-1");
    expect(result.events[1].entityId).toBe("po_ponew");
  });

  it("requires type for generic operational imports and required values for typed events", () => {
    expect(normalizeCsv("po_number,occurred_at\nPO-001,2026-01-01", "s", orders).rejected[0].code).toBe("UNKNOWN_EVENT");
    const receipt = normalizeCsv("po_number,event_type,occurred_at\nPO-001,RECEIPT,2026-01-01", "s", orders);
    expect(receipt.rejected[0].message).toMatch(/quantity is required/i);
    const eta = normalizeCsv("po_number,event_type,occurred_at\nPO-001,SUPPLIER_UPDATE,2026-01-01", "s", orders);
    expect(eta.rejected[0].message).toMatch(/ETA date is required/i);
    const missingDate = normalizeCsv("po_number,event_type,quantity\nPO-001,RECEIPT,2", "s", orders);
    expect(missingDate.rejected[0].message).toMatch(/no epoch fallback/i);
  });
});
