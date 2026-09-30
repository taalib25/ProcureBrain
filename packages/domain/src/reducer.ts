import { sortEvents, type Event } from "./events";
import {
  initialPurchaseOrderState,
  type PurchaseOrderState,
} from "./purchase-order";

function updateReceiptStatus(state: PurchaseOrderState): void {
  if (state.orderedQuantity !== null && state.receivedQuantity >= state.orderedQuantity) {
    state.status = "RECEIVED";
  } else if (state.receivedQuantity > 0) {
    state.status = "PARTIALLY_RECEIVED";
  }
}

export function reducePurchaseOrder(
  state: PurchaseOrderState,
  event: Event,
): PurchaseOrderState {
  if (event.entityType !== state.entityType || event.entityId !== state.entityId) {
    return state;
  }
  if (state.appliedEventIds.includes(event.id)) return state;

  const next: PurchaseOrderState = {
    ...state,
    appliedEventIds: [...state.appliedEventIds, event.id],
    lastOccurredAt: event.occurredAt,
    supplierResponses: [...state.supplierResponses],
  };

  switch (event.eventType) {
    case "PO_CREATED":
      next.supplierId = event.payload.supplierId ?? next.supplierId;
      next.supplierName = event.payload.supplierName ?? next.supplierName;
      next.orderedQuantity = event.payload.quantity ?? next.orderedQuantity;
      next.eta = event.payload.expectedDeliveryDate ?? next.eta;
      break;
    case "SUPPLIER_ETA_CONFIRMED":
    case "SUPPLIER_ETA_CHANGED":
      next.eta = event.payload.eta;
      break;
    case "SUPPLIER_QUANTITY_CONFIRMED":
      next.confirmedQuantity = event.payload.quantity;
      break;
    case "SUPPLIER_QUANTITY_REDUCED":
      next.reducedQuantity = event.payload.quantity;
      next.confirmedQuantity = event.payload.quantity;
      break;
    case "GOODS_RECEIVED":
      next.receivedQuantity += event.payload.quantity ?? 0;
      updateReceiptStatus(next);
      break;
    case "FOLLOWUP_SENT":
      next.followupsSent += 1;
      break;
    case "SUPPLIER_RESPONSE_RECEIVED":
      if (event.payload.response !== undefined) next.supplierResponses.push(event.payload.response);
      break;
  }
  return next;
}

export function replayPurchaseOrder(
  events: readonly Event[],
  entityId?: string,
): PurchaseOrderState {
  const id = entityId ?? events[0]?.entityId;
  if (!id) throw new Error("Cannot replay a purchase order without an entity ID");

  return sortEvents(events).reduce(reducePurchaseOrder, initialPurchaseOrderState(id));
}

export { sortEvents } from "./events";
