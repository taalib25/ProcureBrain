import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/store";

const commitment = { poReference: "PO-1001", eta: "2026-11-10", quantity: null, type: "eta_change", confidence: 0.96, evidence: ["Revised delivery is 2026-11-10."] };
const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup() {
  const store = new MemoryStore();
  const extract = vi.fn(async () => commitment);
  const app = createApp(store, { extractionAdapter: { extract } });
  const draft = async (text: string, sourceRecordId?: string, entityId = "po-1") => {
    const response = await app.request("/api/analysis/supplier-text", request({ text, entityId, sourceRecordId }));
    expect(response.status).toBe(200);
    return await response.json() as { run: { cacheKey: string }; proposal: { sourceRecordId: string } };
  };
  const approve = (key: string, eta = commitment.eta) => app.request(`/api/analysis/runs/${key}/approve`, request({ eta }));
  return { app, store, extract, draft, approve };
}

describe("supplier ETA approval", () => {
  it("requires approval, accepts an edited date, retains evidence, and makes retries idempotent", async () => {
    const { store, draft, approve } = setup();
    const before = store.allEvents().length;
    const text = "PO-1001: Revised delivery is 2026-11-10.";
    const result = await draft(text);
    expect(store.allEvents()).toHaveLength(before);
    expect((await approve(result.run.cacheKey, "2026-11-12")).status).toBe(201);
    expect(store.state("po-1")?.eta).toBe("2026-11-12");
    expect(store.source(result.proposal.sourceRecordId)?.content).toBe(text);
    const retry = await approve(result.run.cacheKey, "2026-11-12");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: "already_applied" });
    expect(store.allEvents()).toHaveLength(before + 1);
  });

  it("allows only one of two divergent approvals against the same PO revision", async () => {
    const { store, draft, approve } = setup();
    const a = await draft("First supplier message");
    const b = await draft("Second supplier message");
    const responses = await Promise.all([approve(a.run.cacheKey, "2026-11-12"), approve(b.run.cacheKey, "2026-11-15")]);
    expect(responses.map(response => response.status).sort()).toEqual([201, 409]);
    expect(store.allEvents().filter(event => event.id.startsWith("approval-"))).toHaveLength(1);
  });

  it("rejects a stale draft after a new confirmation of the same ETA", async () => {
    const { app, store, draft, approve } = setup();
    const result = await draft("Supplier moved delivery");
    const currentEta = store.state("po-1")!.eta;
    const csv = `po,event_type,occurred_at,eta\nPO-1001,ETA_CONFIRMED,2028-01-01T00:00:00Z,${currentEta}`;
    expect((await app.request("/api/imports/supplier-updates", { method: "POST", headers: { "content-type": "text/csv" }, body: csv })).status).toBe(200);
    expect(store.state("po-1")?.eta).toBe(currentEta);
    expect((await approve(result.run.cacheKey)).status).toBe(409);
    // A fresh draft applies after the future-dated imported event during replay.
    const fresh = await draft("Supplier moved delivery");
    expect(fresh.run.cacheKey).not.toBe(result.run.cacheKey);
    expect((await approve(fresh.run.cacheKey)).status).toBe(201);
    expect(store.state("po-1")?.eta).toBe(commitment.eta);
  });

  it("refuses a message that names a different PO and an impossible delivery date", async () => {
    const { draft, approve } = setup();
    const wrong = await draft("PO-1001 is delayed", undefined, "po-2");
    expect((await approve(wrong.run.cacheKey)).status).toBe(409);
    const valid = await draft("PO-1001 is delayed");
    expect((await approve(valid.run.cacheKey, "2026-02-30")).status).toBe(400);
  });

  it("rejects source IDs reused for different supplier evidence without changing the PO", async () => {
    const { store, draft, approve } = setup();
    const first = await draft("Original supplier message", "immutable-source");
    expect((await approve(first.run.cacheKey)).status).toBe(201);
    const before = store.allEvents().length;
    const different = await draft("Different supplier message", "immutable-source");
    expect((await approve(different.run.cacheKey, "2026-11-20")).status).toBe(409);
    expect(store.source("immutable-source")?.content).toBe("Original supplier message");
    expect(store.allEvents()).toHaveLength(before);
  });

  it.each([null, [], { text: 123 }, { text: " " }, { text: "Update", matchingPoCount: -1 }, { text: "Update", retry: "yes" }])("rejects malformed supplier JSON before calling the model: %j", async body => {
    const { app, extract } = setup();
    expect((await app.request("/api/analysis/supplier-text", request(body))).status).toBe(400);
    expect(extract).not.toHaveBeenCalled();
  });

  it.each([null, { rows: "invalid" }, { rows: [{ row: 1, values: { quantity: 12 } }] }])("rejects malformed import JSON: %j", async body => {
    const { app } = setup();
    expect((await app.request("/api/imports/purchase-orders", request(body))).status).toBe(400);
  });

  it("rejects reusing a CSV source ID with different content", async () => {
    const { app, store } = setup();
    const csv = "po,event_type,occurred_at,eta\nPO-1001,ETA_CONFIRMED,2026-10-01T00:00:00Z,2026-11-10";
    expect((await app.request("/api/imports/supplier-updates", request({ csv, sourceRecordId: "csv-source" }))).status).toBe(200);
    expect((await app.request("/api/imports/supplier-updates", request({ csv: csv.replace("2026-11-10", "2026-11-11"), sourceRecordId: "csv-source" }))).status).toBe(409);
    expect(store.source("csv-source")?.content).toBe(csv);
    expect(store.state("po-1")?.eta).toBe("2026-11-10");
  });
});
