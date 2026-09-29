import { describe, expect, it } from "vitest";
import { detectExceptions } from "../../domain/src/exceptions";
import { sortExceptions } from "../../domain/src/priority";
import type { Event } from "../../domain/src/events";

const event = (value: Event): Event => value;
const base = (id: string, type: Event["eventType"], occurredAt: string, payload: never): Event =>
  event({ id, entityType: "PURCHASE_ORDER", entityId: "po-1", eventType: type, occurredAt, ingestedAt: occurredAt, sourceRecordId: `src-${id}`, payload, schemaVersion: 1 } as Event);
const created = (id = "created", quantity = 10) => base(id, "PO_CREATED", "2025-01-01T00:00:00Z", { quantity } as never);

describe("exception failure injections", () => {
  it("does not duplicate a repeated event or report an unknown PO", () => {
    const quantity = base("qty", "SUPPLIER_QUANTITY_REDUCED", "2025-01-02T00:00:00Z", { quantity: 5 } as never);
    const exceptions = detectExceptions([created(), quantity, quantity], { now: "2025-02-01T00:00:00Z" }).filter((x) => x.type === "QUANTITY_SHORT");
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]?.eventIds).toEqual(["created", "qty"]);
    expect(detectExceptions([quantity], { now: "2025-02-01T00:00:00Z" })).toEqual([]);
  });

  it("ignores malformed dates and missing or negative quantities", () => {
    const badEta = base("eta", "SUPPLIER_ETA_CONFIRMED", "2025-01-02T00:00:00Z", { eta: "not-a-date" } as never);
    const badQuantity = base("qty", "SUPPLIER_QUANTITY_REDUCED", "2025-01-03T00:00:00Z", { quantity: -1 } as never);
    expect(detectExceptions([created(), badEta, badQuantity], { now: "2025-02-01T00:00:00Z" })).toEqual([]);
  });

  it("does not turn a receipt before confirmation into a receipt shortfall", () => {
    const receipt = base("receipt", "GOODS_RECEIVED", "2025-01-02T00:00:00Z", { quantity: 2 } as never);
    const confirmation = base("confirmation", "SUPPLIER_QUANTITY_CONFIRMED", "2025-01-03T00:00:00Z", { quantity: 10 } as never);
    expect(detectExceptions([created(), receipt, confirmation], { now: "2025-01-04T00:00:00Z" }).some((x) => x.type === "RECEIPT_SHORT")).toBe(false);
  });

  it("uses event ID as the tie-breaker for equal timestamps", () => {
    const followup = base("b-followup", "FOLLOWUP_SENT", "2025-01-10T00:00:00Z", {} as never);
    const response = base("c-response", "SUPPLIER_RESPONSE_RECEIVED", "2025-01-10T00:00:00Z", { response: "ok" } as never);
    expect(detectExceptions([created(), followup, response], { now: "2025-01-18T00:00:00Z" }).some((x) => x.type === "FOLLOWUP_OVERDUE")).toBe(false);
  });

  it("orders priorities deterministically and supports a threshold", () => {
    const followup = base("followup", "FOLLOWUP_SENT", "2025-01-10T00:00:00Z", {} as never);
    const result = sortExceptions(detectExceptions([created(), followup], { now: "2025-01-11T00:00:00Z", followupThresholdDays: 0 }));
    expect(result[0]?.type).toBe("FOLLOWUP_OVERDUE");
    expect(result[0]?.eventIds).toEqual(["followup"]);
  });
});
