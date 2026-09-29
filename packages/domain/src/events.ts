export const EVENT_TYPES = [
  "PO_CREATED",
  "SUPPLIER_ETA_CONFIRMED",
  "SUPPLIER_ETA_CHANGED",
  "SUPPLIER_QUANTITY_CONFIRMED",
  "SUPPLIER_QUANTITY_REDUCED",
  "GOODS_RECEIVED",
  "FOLLOWUP_SENT",
  "SUPPLIER_RESPONSE_RECEIVED",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type EntityType = "PURCHASE_ORDER";

export interface PoCreatedPayload {
  supplierId?: string;
  supplierName?: string;
  quantity?: number;
  expectedDeliveryDate?: string;
  lineItems?: readonly unknown[];
}

export interface SupplierEtaPayload {
  eta: string;
}

export interface SupplierQuantityPayload {
  quantity: number;
}

export interface GoodsReceivedPayload {
  quantity?: number;
  receivedAt?: string;
}

export interface FollowupSentPayload {
  channel?: string;
  message?: string;
}

export interface SupplierResponsePayload {
  response?: string;
  status?: string;
}

export type EventPayload =
  | PoCreatedPayload
  | SupplierEtaPayload
  | SupplierQuantityPayload
  | GoodsReceivedPayload
  | FollowupSentPayload
  | SupplierResponsePayload;

export interface EventPayloadByType {
  PO_CREATED: PoCreatedPayload;
  SUPPLIER_ETA_CONFIRMED: SupplierEtaPayload;
  SUPPLIER_ETA_CHANGED: SupplierEtaPayload;
  SUPPLIER_QUANTITY_CONFIRMED: SupplierQuantityPayload;
  SUPPLIER_QUANTITY_REDUCED: SupplierQuantityPayload;
  GOODS_RECEIVED: GoodsReceivedPayload;
  FOLLOWUP_SENT: FollowupSentPayload;
  SUPPLIER_RESPONSE_RECEIVED: SupplierResponsePayload;
}

/** Immutable canonical envelope. `occurredAt` is operational time. */
export interface CanonicalEvent<T extends EventType = EventType> {
  readonly id: string;
  readonly entityType: EntityType;
  readonly entityId: string;
  readonly eventType: T;
  readonly occurredAt: string;
  readonly ingestedAt: string;
  readonly sourceRecordId: string;
  readonly payload: Readonly<EventPayloadByType[T]>;
  readonly schemaVersion: 1;
}

export type Event = {
  [T in EventType]: CanonicalEvent<T>;
}[EventType];

export function sortEvents(events: readonly Event[]): Event[] {
  return [...events].sort((left, right) => {
    const byOccurredAt = left.occurredAt.localeCompare(right.occurredAt);
    return byOccurredAt || left.id.localeCompare(right.id);
  });
}
