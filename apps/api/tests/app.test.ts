import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("API", () => {
  it("serves health, projected POs, and derived exceptions", async () => {
    const app = createApp();
    expect((await app.request("/api/health")).status).toBe(200);
    expect((await app.request("/api/purchase-orders")).status).toBe(200);
    const exceptions = await (await app.request("/api/exceptions")).json() as unknown[];
    expect(exceptions.length).toBeGreaterThan(0);
  });

  it("imports plain purchase-order CSV without event_type and deduplicates it", async () => {
    const app = createApp();
    const csv = "po_number,supplier_name,order_date,quantity\nPO-NEW-300,Acme Parts,2025-04-03,12";
    const send = () => app.request("/api/imports/purchase-orders", { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
    const first = await send();
    const second = await send();
    const imported = await first.json() as { sourceRecordId: string; inserted: number; events: Array<{ eventType: string }> };
    expect(imported.inserted).toBe(1);
    expect(imported.events[0]?.eventType).toBe("PO_CREATED");
    expect((await second.json() as { inserted: number }).inserted).toBe(0);
    const source = await (await app.request(`/api/sources/${imported.sourceRecordId}`)).json() as { content: string; evidence: unknown[] };
    expect(source.content).toBe(csv);
    expect(source.evidence).toHaveLength(1);
  });

  it("converts JSON rows to the purchase-order CSV normalization contract", async () => {
    const app = createApp();
    const body = { rows: [{ row: 1, values: { po_number: "PO-JSON-4", supplier_name: "Contoso", order_date: "2025-05-01", quantity: "7" } }] };
    const response = await app.request("/api/imports/purchase-orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const imported = await response.json() as { inserted: number; events: Array<{ entityId: string }> };
    expect(response.status).toBe(200);
    expect(imported.inserted).toBe(1);
    expect(imported.events[0]?.entityId).toBe("po_pojson4");
  });

  it("does not create an unknown PO from an event import", async () => {
    const app = createApp();
    const csv = "po,event_type,occurred_at,quantity\nPO-UNKNOWN,QUANTITY_CONFIRMED,2025-02-01T00:00:00Z,20";
    const response = await app.request("/api/imports/supplier-updates", { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
    const result = await response.json() as { inserted: number; unresolved: unknown[] };
    expect(result.inserted).toBe(0);
    expect(result.unresolved).toHaveLength(1);
  });

  it("coalesces concurrent identical uploads and returns retained source evidence", async () => {
    const app = createApp();
    const csv = "po,event_type,occurred_at,quantity\nPO-X77,PO_CREATED,2025-02-01T00:00:00Z,4";
    const send = () => app.request("/api/imports/purchase-orders", { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
    const [a, b] = await Promise.all([send(), send()]);
    const aResult = await a.json() as { inserted: number; sourceRecordId: string };
    const bResult = await b.json() as { inserted: number; sourceRecordId: string };
    expect(aResult.sourceRecordId).toBe(bResult.sourceRecordId);
    expect(aResult.inserted + bResult.inserted).toBe(1);
    const source = await (await app.request(`/api/sources/${aResult.sourceRecordId}`)).json() as { content: string; evidence: unknown[] };
    expect(source.content).toBe(csv);
    expect(source.evidence).toHaveLength(1);
  });

  it("returns cached deterministic CSV analyses with zero model-token usage", async () => {
    const app = createApp();
    const body = JSON.stringify({ csv: "po,event_type,quantity\nPO-900,PO_CREATED,2", sourceRecordId: "analysis-test" });
    const first = await app.request("/api/analysis/csv", { method: "POST", headers: { "content-type": "application/json" }, body });
    const second = await app.request("/api/analysis/csv", { method: "POST", headers: { "content-type": "application/json" }, body });
    expect((await first.json() as { cacheHit: boolean }).cacheHit).toBe(false);
    const replay = await second.json() as { cacheHit: boolean; usage: { totalTokens: number } };
    expect(replay.cacheHit).toBe(true);
    expect(replay.usage.totalTokens).toBe(0);
  });
});
