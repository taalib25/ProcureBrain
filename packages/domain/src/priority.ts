import type { ExceptionType, ProcurementException } from "./exceptions";

/** Lower values are more urgent. Keeping this table public makes ordering auditable. */
export const EXCEPTION_PRIORITY: Readonly<Record<ExceptionType, number>> = {
  LATE_PO: 10,
  QUANTITY_SHORT: 20,
  RECEIPT_SHORT: 30,
  FOLLOWUP_OVERDUE: 40,
  ETA_CHANGED: 50,
};

export function priorityForException(type: ExceptionType): number {
  return EXCEPTION_PRIORITY[type];
}

/** Stable ordering: urgency, PO, rule, then evidence IDs. */
export function compareExceptions(
  left: ProcurementException,
  right: ProcurementException,
): number {
  return (
    left.priority - right.priority ||
    left.entityId.localeCompare(right.entityId) ||
    left.type.localeCompare(right.type) ||
    left.eventIds.join("\u0000").localeCompare(right.eventIds.join("\u0000"))
  );
}

export function sortExceptions(
  exceptions: readonly ProcurementException[],
): ProcurementException[] {
  return [...exceptions].sort(compareExceptions);
}

export const orderExceptions = sortExceptions;
