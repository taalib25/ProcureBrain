import type { Event } from "./events";

export interface PurchaseOrderState {
  entityType: "PURCHASE_ORDER";
  entityId: string;
  supplierId: string | null;
  supplierName: string | null;
  orderedQuantity: number | null;
  confirmedQuantity: number | null;
  reducedQuantity: number | null;
  receivedQuantity: number;
  eta: string | null;
  status: "OPEN" | "PARTIALLY_RECEIVED" | "RECEIVED";
  followupsSent: number;
  supplierResponses: string[];
  appliedEventIds: string[];
  lastOccurredAt: string | null;
}

export function initialPurchaseOrderState(entityId: string): PurchaseOrderState {
  return {
    entityType: "PURCHASE_ORDER",
    entityId,
    supplierId: null,
    supplierName: null,
    orderedQuantity: null,
    confirmedQuantity: null,
    reducedQuantity: null,
    receivedQuantity: 0,
    eta: null,
    status: "OPEN",
    followupsSent: 0,
    supplierResponses: [],
    appliedEventIds: [],
    lastOccurredAt: null,
  };
}

export type PurchaseOrderEvent = Event;
