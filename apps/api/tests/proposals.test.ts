import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import { MemoryStore } from "../src/store";

const etaCommitment = {
  poReference: "PO-1001",
  eta: "2026-11-10",
  quantity: null,
  type: "eta_change",
  confidence: 0.96,
  evidence: ["PO-1001 revised delivery is 2026-11-10."],
};
const qtyCommitment = {
  poReference: "PO-1002",
  eta: null,
  quantity: 30,
  type: "quantity_change",
  confidence: 0.96,
  evidence: ["PO-1002 revised quantity is 30."],
};
const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup(commitment: unknown = etaCommitment) {
  const store = new MemoryStore();
  const extract = vi.fn(async () => commitment);
  const app = createApp(store, { extractionAdapter: { extract } });
  const draft = async (text: string, entityId = "po-1") => {
    const response = await app.request("/api/analysis/supplier-text", request({ text, entityId }));
    expect(response.status).toBe(200);
    return (await response.json()) as {
      run: { cacheKey: string };
      changeProposal: { id: string; status: string; proposalType: string } | null;
    };
  };
  return { app, store, draft };
}

describe("change proposals", () => {
  it("runs the ETA lifecycle: list, approve, idempotent re-approve, reject-after-applied refused", async () => {
    const { app, draft } = setup();
    const { run, changeProposal } = await draft("PO-1001 delayed");
    expect(changeProposal?.status).toBe("PENDING");
    expect(changeProposal?.proposalType).toBe("ETA_CHANGE");

    const listed = (await (await app.request("/api/proposals")).json()) as Array<{ id: string }>;
    expect(listed.map((proposal) => proposal.id)).toContain(changeProposal?.id);
    expect((await app.request(`/api/proposals/${changeProposal?.id}`)).status).toBe(200);
    expect((await app.request("/api/proposals/missing")).status).toBe(404);

    const approved = await app.request(`/api/proposals/${changeProposal?.id}/approve`, request({}));
    expect(approved.status).toBe(201);
    expect(((await approved.json()) as { proposal: { status: string } }).proposal.status).toBe("APPLIED");

    const retry = await app.request(`/api/proposals/${changeProposal?.id}/approve`, request({}));
    expect(retry.status).toBe(200);

    const reject = await app.request(`/api/proposals/${changeProposal?.id}/reject`, request({ reason: "too late" }));
    expect(reject.status).toBe(409);

    // The compatibility shim still works and stays idempotent.
    const shim = await app.request(`/api/analysis/runs/${run.cacheKey}/approve`, request({}));
    expect(shim.status).toBe(200);
  });

  it("rejects through the proposal endpoint and blocks the shim afterwards", async () => {
    const { app, draft } = setup();
    const { run, changeProposal } = await draft("PO-1001 delayed");
    const rejected = await app.request(`/api/proposals/${changeProposal?.id}/reject`, request({ reason: "not needed" }));
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { status: string }).status).toBe("REJECTED");
    const again = await app.request(`/api/proposals/${changeProposal?.id}/reject`, request({}));
    expect(again.status).toBe(200);

    const shim = await app.request(`/api/analysis/runs/${run.cacheKey}/approve`, request({}));
    expect(shim.status).toBe(409);
    expect(((await shim.json()) as { proposalId?: string }).proposalId).toBe(changeProposal?.id);

    const approveRejected = await app.request(`/api/proposals/${changeProposal?.id}/approve`, request({}));
    expect(approveRejected.status).toBe(409);
  });

  it("approves with an edit and marks stale proposals", async () => {
    const { app, store, draft } = setup();
    const first = await draft("PO-1001 delayed");
    const edited = await app.request(`/api/proposals/${first.changeProposal?.id}/approve-with-edit`, request({ eta: "2026-11-12" }));
    expect(edited.status).toBe(201);
    expect(((await edited.json()) as { proposal: { status: string } }).proposal.status).toBe("APPLIED");
    expect(store.state("po-1")?.eta).toBe("2026-11-12");
    expect((await app.request(`/api/proposals/${first.changeProposal?.id}/approve-with-edit`, request({}))).status).toBe(400);

    const second = await draft("PO-1001 delayed again");
    const rival = await draft("PO-1001 delayed a third time");
    expect((await app.request(`/api/analysis/runs/${rival.run.cacheKey}/approve`, request({}))).status).toBe(201);
    const stale = await app.request(`/api/analysis/runs/${second.run.cacheKey}/approve`, request({}));
    expect(stale.status).toBe(409);
    const marked = (await (await app.request(`/api/proposals/${second.changeProposal?.id}`)).json()) as { proposal: { status: string } };
    expect(marked.proposal.status).toBe("STALE");
    const approveStale = await app.request(`/api/proposals/${second.changeProposal?.id}/approve`, request({}));
    expect(approveStale.status).toBe(409);
  });

  it("approves quantity changes through proposals while the run-key shim stays ETA-only", async () => {
    const { app, store, draft } = setup(qtyCommitment);
    const { run, changeProposal } = await draft("PO-1002 quantity update", "po-2");
    expect(changeProposal?.proposalType).toBe("QUANTITY_CHANGE");

    const shim = await app.request(`/api/analysis/runs/${run.cacheKey}/approve`, request({}));
    expect(shim.status).toBe(400);

    const invalid = await app.request(`/api/proposals/${changeProposal?.id}/approve`, request({ quantity: -4 }));
    expect(invalid.status).toBe(400);
    expect(store.state("po-2")?.confirmedQuantity).not.toBe(30);

    const approved = await app.request(`/api/proposals/${changeProposal?.id}/approve`, request({}));
    expect(approved.status).toBe(201);
    const result = (await approved.json()) as { event: { eventType: string }; proposal: { status: string } };
    expect(result.event.eventType).toBe("SUPPLIER_QUANTITY_CONFIRMED");
    expect(result.proposal.status).toBe("APPLIED");
    expect(store.state("po-2")?.confirmedQuantity).toBe(30);

    const unchanged = await draft("another quantity confirmation", "po-2");
    expect(unchanged.changeProposal).toBeNull();
  });
});
