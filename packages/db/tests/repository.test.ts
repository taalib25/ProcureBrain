import { describe, expect, it } from "vitest";
import { createEventRepository } from "../src/repository";

describe("event repository", () => {
  it("uses conflict-safe inserts for source records and events", async () => {
    const calls: unknown[] = [];
    const db = { insert: (table: unknown) => ({ values: (values: unknown) => ({ onConflictDoNothing: async () => { calls.push({ table, values }); } }) }) };
    const repository = createEventRepository(db);
    await repository.insertSourceRecord({ id: "source-1", sourceType: "csv", content: "", importedAt: new Date() });
    await repository.insertEvents([{
      id: "evt_1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: "2026-01-01T00:00:00Z", ingestedAt: "2026-01-01T00:00:00Z", sourceRecordId: "source-1", payload: { quantity: 1 }, schemaVersion: 1,
    }]);
    expect(calls).toHaveLength(2);
    expect((calls[1] as { values: { idempotencyKey: string } }).values.idempotencyKey).toMatch(/^v1_/);
  });
});
