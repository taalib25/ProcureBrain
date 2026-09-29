import { describe, expect, it } from "vitest";
import { replayPurchaseOrder, sortEvents } from "../src/reducer";
import type { Event } from "../src/events";

const event = <T extends Event>(value: T): T => value;

describe("purchase-order replay", () => {
  it("sorts late arrivals by occurredAt and then event ID", () => {
    const events: Event[] = [
      event({ id: "b", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "SUPPLIER_ETA_CHANGED", occurredAt: "2025-01-03T00:00:00Z", ingestedAt: "2025-01-04T00:00:00Z", sourceRecordId: "r3", payload: { eta: "2025-01-20" }, schemaVersion: 1 }),
      event({ id: "a", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "PO_CREATED", occurredAt: "2025-01-01T00:00:00Z", ingestedAt: "2025-01-03T00:00:00Z", sourceRecordId: "r1", payload: { quantity: 10 }, schemaVersion: 1 }),
      event({ id: "c", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "SUPPLIER_ETA_CONFIRMED", occurredAt: "2025-01-03T00:00:00Z", ingestedAt: "2025-01-03T00:00:00Z", sourceRecordId: "r2", payload: { eta: "2025-01-15" }, schemaVersion: 1 }),
    ];
    expect(sortEvents(events).map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(replayPurchaseOrder(events).eta).toBe("2025-01-15");
  });

  it("replays deterministically without mutating input or state", () => {
    const created = event({ id: "1", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "PO_CREATED", occurredAt: "2025-01-01T00:00:00Z", ingestedAt: "2025-01-01T00:00:01Z", sourceRecordId: "r1", payload: { supplierId: "s1", quantity: 10 }, schemaVersion: 1 });
    const received = event({ id: "2", entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: "GOODS_RECEIVED", occurredAt: "2025-01-02T00:00:00Z", ingestedAt: "2025-01-02T00:00:01Z", sourceRecordId: "r2", payload: { quantity: 4 }, schemaVersion: 1 });
    const input = [received, created];
    const first = replayPurchaseOrder(input);
    const second = replayPurchaseOrder(input);
    expect(first).toEqual(second);
    expect(input.map(({ id }) => id)).toEqual(["2", "1"]);
  });
});
