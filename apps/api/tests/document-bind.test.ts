import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/store";

const commitment = {
  poReference: "PO-1001",
  eta: "2026-11-10",
  quantity: null,
  type: "eta_change",
  confidence: 0.96,
  evidence: ["PO-1001 revised delivery is 2026-11-10."],
};
const ocrText = "PO-1001 revised delivery is 2026-11-10.";
const ocrAdapter = { extract: vi.fn(async () => ({ text: ocrText, confidence: 0.95, pages: [] })) };
const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup() {
  const store = new MemoryStore();
  const app = createApp(store, {
    extractionAdapter: { extract: vi.fn(async () => commitment) },
    ocrAdapter,
  });
  const upload = () => app.request("/api/analysis/image", {
    method: "POST",
    headers: { "content-type": "image/png", "idempotency-key": "invoice-1" },
    body: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
  return { app, store, upload };
}

describe("document bind to purchase order", () => {
  it("suggests PO candidates on upload, then binds, approves, and records the document source type", async () => {
    const { app, store, upload } = setup();
    const analyzed = await upload();
    expect(analyzed.status).toBe(200);
    const analysis = await analyzed.json() as {
      run: { cacheKey: string };
      poCandidates: Array<{ entityId: string; poNumber: string }>;
    };
    expect(analysis.poCandidates).toEqual([{ entityId: "po-1", poNumber: "PO-1001" }]);

    const bindResponse = await app.request(`/api/analysis/runs/${analysis.run.cacheKey}/bind`, request({ entityId: "po-1" }));
    expect(bindResponse.status).toBe(200);
    const bound = await bindResponse.json() as {
      proposal: { state: string; commitment: typeof commitment; sourceText: string };
      run: { cacheKey: string };
      baseline: { poReference: string; eta: string | null };
    };
    expect(bound.proposal.state).toBe("VALID");
    expect(bound.proposal.sourceText).toBe(ocrText);
    expect(bound.baseline.poReference).toBe("PO-1001");

    const approve = await app.request(`/api/analysis/runs/${bound.run.cacheKey}/approve`, request({}));
    expect(approve.status).toBe(201);
    expect(store.state("po-1")?.eta).toBe("2026-11-10");
    const source = store.source("invoice-1");
    expect(source?.content).toBe(ocrText);
    expect((source as { sourceType?: string } | undefined)?.sourceType).toBe("supplier_image");
  });

  it("rejects binding unknown runs, non-document runs, unknown POs, and empty extractions", async () => {
    const { app, upload } = setup();
    expect((await app.request("/api/analysis/runs/missing/bind", request({ entityId: "po-1" }))).status).toBe(404);

    const textApp = (() => {
      const store = new MemoryStore();
      const text = createApp(store, { extractionAdapter: { extract: async () => commitment } });
      return text;
    })();
    const textRun = await (await textApp.request("/api/analysis/supplier-text", request({ text: "PO-1001 delayed", entityId: "po-1" }))).json() as { run: { cacheKey: string } };
    expect((await textApp.request(`/api/analysis/runs/${textRun.run.cacheKey}/bind`, request({ entityId: "po-1" }))).status).toBe(409);

    const doc = await (await upload()).json() as { run: { cacheKey: string } };
    expect((await app.request(`/api/analysis/runs/${doc.run.cacheKey}/bind`, request({ entityId: "po-missing" }))).status).toBe(404);
    expect((await app.request(`/api/analysis/runs/${doc.run.cacheKey}/bind`, request({}))).status).toBe(400);

    const emptyStore = new MemoryStore();
    const emptyApp = createApp(emptyStore, {
      extractionAdapter: { extract: async () => { throw new Error("no model"); } },
      ocrAdapter: { extract: async () => ({ text: "unreadable", confidence: 0.1, pages: [] }) },
    });
    const empty = await (await emptyApp.request("/api/analysis/image", {
      method: "POST",
      headers: { "content-type": "image/png", "idempotency-key": "invoice-empty" },
      body: new Uint8Array([1, 2, 3]),
    })).json() as { run: { cacheKey: string } };
    expect((await emptyApp.request(`/api/analysis/runs/${empty.run.cacheKey}/bind`, request({ entityId: "po-1" }))).status).toBe(409);
  });

  it("validates channel sourceType and provenance on supplier text", async () => {
    const store = new MemoryStore();
    const app = createApp(store, { extractionAdapter: { extract: async () => commitment } });
    const send = (body: unknown) => app.request("/api/analysis/supplier-text", request(body));

    const badType = await send({ text: "hi", sourceType: "carrier_pigeon" });
    expect(badType.status).toBe(400);
    const missingProv = await send({ text: "hi", sourceType: "whatsapp" });
    expect(missingProv.status).toBe(400);
    const badDate = await send({ text: "hi", sourceType: "supplier_email", provenance: { sender: "a@b.co", channelMessageId: "m1", receivedAt: "yesterday" } });
    expect(badDate.status).toBe(400);

    const good = await send({
      text: "PO-1001 revised delivery is 2026-11-10.",
      entityId: "po-1",
      sourceRecordId: "whatsapp-1",
      sourceType: "whatsapp",
      provenance: { sender: "+15550123456", channelMessageId: "wamid.1", receivedAt: "2026-09-01T10:00:00Z" },
    });
    expect(good.status).toBe(200);
    const result = await good.json() as { run: { cacheKey: string; request: { context: { sourceType: string } } } };
    expect(result.run.request.context.sourceType).toBe("whatsapp");

    const approval = await app.request(`/api/analysis/runs/${result.run.cacheKey}/approve`, request({}));
    expect(approval.status).toBe(201);
    expect((store.source("whatsapp-1") as { sourceType?: string } | undefined)?.sourceType).toBe("whatsapp");
  });
});
