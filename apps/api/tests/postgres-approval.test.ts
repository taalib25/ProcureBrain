import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PostgresStore, purchaseOrderRevision, SourceRecordConflictError, type ApprovedEtaChange } from "../src/store";

const connectionString = process.env.PROCUREBRAIN_TEST_DATABASE_URL;
describe.skipIf(!connectionString)("approval against real PostgreSQL", () => {
  const schema = `pb_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let store: PostgresStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString });
    await admin.query(`create schema ${schema}`);
    pool = new Pool({ connectionString, options: `-c search_path=${schema}`, max: 10 });
    await pool.query(await readFile(new URL("../migrations/0001_runtime.sql", import.meta.url), "utf8"));
    store = new PostgresStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`drop schema if exists ${schema} cascade`); await admin.end(); }
  });
  async function draft(po: string): Promise<ApprovedEtaChange> {
    const imported = await store.importCsv(`po_number,supplier_name,order_date,quantity,eta\n${po},Supplier,2028-01-01,10,2028-01-20`, `source-${po}`, "purchase_orders");
    const entityId = imported.events[0]!.entityId;
    const current = (await store.state(entityId))!;
    return { entityId, expectedEta: current.eta, expectedRevision: purchaseOrderRevision(current), approvalId: `run-${po}`, eta: "2028-02-01", approvedAt: "2026-10-01T00:00:00Z", sourceRecordId: `message-${po}`, sourceText: "Supplier confirms February 1 delivery" };
  }

  it("serializes divergent approvals and returns the saved event on a retry", async () => {
    const input = await draft("PO-CONCURRENT");
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.applyApprovedEtaChange({ ...input, approvalId: `run-${i}`, sourceRecordId: `msg-${i}`, eta: `2028-02-0${i + 1}` })));
    expect(results.filter(result => result.status === "applied")).toHaveLength(1);
    expect(results.filter(result => result.status === "stale")).toHaveLength(7);
    expect(await store.timeline(input.entityId)).toHaveLength(2);
    const index = results.findIndex(result => result.status === "applied");
    const retry = await store.applyApprovedEtaChange({ ...input, approvalId: `run-${index}`, sourceRecordId: `msg-${index}`, eta: `2028-02-0${index + 1}`, approvedAt: "2026-10-02T00:00:00Z" });
    expect(retry.status).toBe("already_applied");
    expect((await store.state(input.entityId))?.eta).toBe(`2028-02-0${index + 1}`);
  });

  it("rejects a draft after an import confirms the same ETA", async () => {
    const input = await draft("PO-SAME-ETA");
    await store.importCsv(`po,event_type,occurred_at,eta\nPO-SAME-ETA,ETA_CONFIRMED,2028-01-02T00:00:00Z,${input.expectedEta}`, "same-eta-confirmation");
    expect((await store.applyApprovedEtaChange(input)).status).toBe("stale");
    expect(await store.timeline(input.entityId)).toHaveLength(2);
  });

  it("rolls back a conflicting source without attaching events to old evidence", async () => {
    const input = await draft("PO-EVIDENCE");
    await store.applyApprovedEtaChange(input);
    const current = (await store.state(input.entityId))!;
    await expect(store.applyApprovedEtaChange({ ...input, expectedEta: current.eta, expectedRevision: purchaseOrderRevision(current), approvalId: "different-run", eta: "2028-03-01", sourceText: "Different message" })).rejects.toBeInstanceOf(SourceRecordConflictError);
    expect(await store.timeline(input.entityId)).toHaveLength(2);
    expect((await store.source(input.sourceRecordId)).content).toBe(input.sourceText);
  });
});
