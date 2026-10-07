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
const request = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function setup() {
  const store = new MemoryStore();
  const extract = vi.fn(async () => commitment);
  const app = createApp(store, { extractionAdapter: { extract } });
  const ingest = (body: unknown) => app.request("/api/messages", request(body));
  const process = (id: string) => app.request(`/api/messages/${id}/process`, request({}));
  return { app, store, extract, ingest, process };
}

const manual = (text: string, extra: Record<string, unknown> = {}) => ({
  channel: "supplier_message",
  text,
  ...extra,
});

describe("supplier messages", () => {
  it("ingests manual messages idempotently and validates channels", async () => {
    const { ingest } = setup();
    const first = await ingest(manual("PO-1001 delayed"));
    expect(first.status).toBe(201);
    const body = await first.json() as { message: { id: string; processingStatus: string }; created: boolean };
    expect(body.created).toBe(true);
    expect(body.message.processingStatus).toBe("RECEIVED");
    const replay = await ingest(manual("PO-1001 delayed"));
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as typeof body).message.id).toBe(body.message.id);

    expect((await ingest({ channel: "carrier_pigeon", text: "hi" })).status).toBe(400);
    expect((await ingest({ channel: "supplier_email", text: "hi" })).status).toBe(400);
    expect((await ingest({ channel: "supplier_email", text: "hi", sender: "a@b.co", receivedAt: "not-a-date" })).status).toBe(400);
    expect((await ingest({ channel: "supplier_email", text: "hi", sender: "a@b.co", sentAt: "yesterday" })).status).toBe(400);
  });

  it("processes an exact reference into a proposal without a second model call on reprocess", async () => {
    const { app, extract, ingest, process } = setup();
    const id = ((await (await ingest(manual("PO-1001 revised delivery is 2026-11-10."))).json()) as { message: { id: string } }).message.id;
    const first = await process(id);
    expect(first.status).toBe(200);
    const result = await first.json() as {
      status: string;
      candidates: Array<{ entityId: string; matchMethod: string; isSelected: boolean }>;
      proposal: { state: string } | null;
      runKey: string | null;
    };
    expect(result.status).toBe("PROPOSAL_CREATED");
    expect(result.candidates).toMatchObject([{ entityId: "po-1", matchMethod: "EXACT_PO_REFERENCE", isSelected: true }]);
    expect(result.proposal?.state).toBe("VALID");
    expect(typeof result.runKey).toBe("string");
    expect(extract).toHaveBeenCalledTimes(1);

    const second = await process(id);
    expect(((await second.json()) as typeof result).status).toBe("PROPOSAL_CREATED");
    expect(extract).toHaveBeenCalledTimes(1);

    const fetched = await (await app.request(`/api/messages/${id}`)).json() as { message: { processingStatus: string }; candidates: unknown[] };
    expect(fetched.message.processingStatus).toBe("PROPOSAL_CREATED");
    expect(fetched.candidates).toHaveLength(1);

    const approval = await app.request(`/api/analysis/runs/${result.runKey}/approve`, request({}));
    expect(approval.status).toBe(201);
  });

  it("routes ambiguous and unknown messages to review without calling the model", async () => {
    const { extract, ingest, process } = setup();
    const ambiguous = ((await (await ingest(manual("PO-1001 and PO-1002 both delayed"))).json()) as { message: { id: string } }).message.id;
    const ambivalent = await (await process(ambiguous)).json() as { status: string; candidates: unknown[] };
    expect(ambivalent.status).toBe("REVIEW_REQUIRED");
    expect(ambivalent.candidates).toHaveLength(2);

    const unknown = ((await (await ingest(manual("just checking in, no order mentioned"))).json()) as { message: { id: string } }).message.id;
    const unsolved = await (await process(unknown)).json() as { status: string; candidates: unknown[] };
    expect(unsolved.status).toBe("REVIEW_REQUIRED");
    expect(unsolved.candidates).toHaveLength(0);
    expect(extract).not.toHaveBeenCalled();
  });

  it("falls back to the sender's single open PO and honors manual links", async () => {
    const { app, store, ingest, process } = setup();
    store.createSupplier({ supplierCode: "NORTHSTAR", name: "Northstar Components", primaryEmail: "sales@northstar.test" }, "org-dev");
    const id = ((await (await ingest({
      channel: "supplier_email",
      sender: "sales@northstar.test",
      subject: "delay",
      text: "delivery moved to 2026-11-10, details to follow",
      externalMessageId: "m-1",
      receivedAt: "2026-09-01T10:00:00Z",
    })).json()) as { message: { id: string } }).message.id;
    const result = await (await process(id)).json() as {
      status: string;
      candidates: Array<{ entityId: string; matchMethod: string; isSelected: boolean }>;
      message: { supplierId: string | null };
    };
    expect(result.status).toBe("PROPOSAL_CREATED");
    expect(result.candidates).toMatchObject([{ matchMethod: "SUPPLIER_OPEN_PO", isSelected: true }]);
    expect(result.candidates[0]?.entityId).toBe("po-1");
    expect(typeof result.message.supplierId).toBe("string");

    const other = ((await (await ingest(manual("some vague delay, please advise"))).json()) as { message: { id: string } }).message.id;
    expect(((await (await process(other)).json()) as { status: string }).status).toBe("REVIEW_REQUIRED");
    const linked = await (await app.request(`/api/messages/${other}/link-purchase-order`, request({ entityId: "po-2" }))).json() as {
      candidates: Array<{ matchMethod: string; isSelected: boolean }>;
    };
    expect(linked.candidates).toMatchObject([{ matchMethod: "USER_SELECTED", isSelected: true }]);
    const afterLink = await (await process(other)).json() as { status: string; runKey: string | null };
    expect(afterLink.status).toBe("PROPOSAL_CREATED");
    expect(typeof afterLink.runKey).toBe("string");
    expect((await app.request(`/api/messages/unknown-id/link-purchase-order`, request({ entityId: "po-1" }))).status).toBe(404);
    expect((await app.request(`/api/messages/${other}/link-purchase-order`, request({ entityId: "po-missing" }))).status).toBe(404);
  });

  it("lists messages per org and 404s across orgs", async () => {
    const { app, ingest } = setup();
    await ingest(manual("PO-1001 delayed"));
    expect(((await (await app.request("/api/messages")).json()) as unknown[])).toHaveLength(1);
    expect((await app.request("/api/messages/nope")).status).toBe(404);
    expect((await app.request("/api/messages/nope/process", request({}))).status).toBe(404);
  });
});
