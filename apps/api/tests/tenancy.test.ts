import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { DEFAULT_ORG, MemoryStore, scopedEntityId, scopeImportEvents, SupplierConflictError } from "../src/store";

const poCsv = (po: string, supplier: string) =>
  `po_number,supplier_name,order_date,quantity\n${po},${supplier},2025-04-03,12`;
const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("tenancy", () => {
  it("scopes entity ids per org while keeping the default org stable", () => {
    expect(scopedEntityId(DEFAULT_ORG, "po_pojson4")).toBe("po_pojson4");
    expect(scopedEntityId("org-acme", "po_pojson4")).toBe("po_org-acme_pojson4");
    expect(scopedEntityId("org-acme", "po-1")).toBe("po_org-acme_1");
    expect(scopeImportEvents([], "org-acme")).toEqual([]);
  });

  it("isolates PO identity per org: same po_number in two orgs, no duplicate identity in one", async () => {
    const store = new MemoryStore();
    const first = store.importCsv(poCsv("PO-X1", "Acme"), "source-a1", "purchase_orders", "org-a");
    const second = store.importCsv(poCsv("PO-X1", "Acme"), "source-b1", "purchase_orders", "org-b");
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(1);
    const entityA = first.events[0]?.entityId;
    const entityB = second.events[0]?.entityId;
    expect(entityA).not.toBe(entityB);
    expect(store.purchaseOrderReferences("org-a")).toHaveLength(1);
    expect(store.purchaseOrderReferences("org-b")).toHaveLength(1);
    expect(store.purchaseOrderReferences("org-a").some((reference) => reference.entityId === entityB)).toBe(false);

    const repeat = store.importCsv(poCsv("PO-X1", "Acme"), "source-a2", "purchase_orders", "org-a");
    expect(repeat.inserted).toBe(0);
    expect(store.purchaseOrderReferences("org-a")).toHaveLength(1);
    expect(store.purchaseOrders("org-b").map((order) => order.entityId)).toEqual([entityB]);
    expect(store.purchaseOrders().length).toBeGreaterThan(store.purchaseOrders("org-b").length);
  });

  it("manages suppliers per org with code conflicts rejected", () => {
    const store = new MemoryStore();
    const created = store.createSupplier({ supplierCode: "ACME", name: "Acme Parts", primaryEmail: "sales@acme.test" }, "org-a");
    expect(created.emailDomain).toBe("acme.test");
    expect(() => store.createSupplier({ supplierCode: "acme", name: "Acme Again" }, "org-a")).toThrow(SupplierConflictError);
    // Same code in another org is a different supplier.
    const other = store.createSupplier({ supplierCode: "ACME", name: "Acme Parts" }, "org-b");
    expect(other.id).not.toBe(created.id);
    expect(store.suppliers("org-a")).toHaveLength(1);
    expect(store.supplier(created.id, "org-b")).toBeUndefined();
  });

  it("serves supplier endpoints scoped by header org with 409 on duplicates", async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const create = (org: string, code: string) => app.request("/api/suppliers", {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": org },
      body: JSON.stringify({ supplierCode: code, name: "Acme Parts" }),
    });
    expect((await create("org-a", "ACME")).status).toBe(201);
    expect((await create("org-a", "acme")).status).toBe(409);
    expect((await create("org-b", "ACME")).status).toBe(201);
    const listed = await (await app.request("/api/suppliers", { headers: { "x-organization-id": "org-a" } })).json() as Array<{ id: string }>;
    expect(listed).toHaveLength(1);
    expect((await app.request(`/api/suppliers/${listed[0]?.id}`, { headers: { "x-organization-id": "org-b" } })).status).toBe(404);
    expect((await app.request(`/api/suppliers/${listed[0]?.id}/purchase-orders`, { headers: { "x-organization-id": "org-a" } })).status).toBe(200);
    expect((await app.request("/api/suppliers", request({ supplierCode: "", name: "" }))).status).toBe(400);
  });

  it("rejects malformed organization headers and enforces the tenant boundary on approval", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { extractionAdapter: { extract: async () => ({ poReference: "PO-1001", eta: "2026-11-10", quantity: null, type: "eta_change", confidence: 0.96, evidence: ["x"] }) } });
    expect((await app.request("/api/purchase-orders", { headers: { "x-organization-id": "BAD ORG!" } })).status).toBe(400);

    const draft = await (await app.request("/api/analysis/supplier-text", request({ text: "PO-1001 delayed", entityId: "po-1", sourceRecordId: "tenant-src" }))).json() as { run: { cacheKey: string } };
    // po-1 belongs to the default org; approving from another org must not find it.
    const foreign = await app.request(`/api/analysis/runs/${draft.run.cacheKey}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-organization-id": "org-acme" },
      body: JSON.stringify({}),
    });
    expect(foreign.status).toBe(404);
    const home = await app.request(`/api/analysis/runs/${draft.run.cacheKey}/approve`, request({}));
    expect(home.status).toBe(201);
    expect((store.source("tenant-src") as { organizationId?: string } | undefined)?.organizationId).toBe("org-dev");
  });
});
