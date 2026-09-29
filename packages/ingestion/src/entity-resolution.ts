import type { PurchaseOrderReference, Resolution } from "./types";

export function normalizePoReference(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function resolvePurchaseOrder(reference: string, purchaseOrders: readonly PurchaseOrderReference[]): Resolution {
  const exact = purchaseOrders.filter((po) => [po.poNumber, ...(po.aliases ?? [])].some((candidate) => candidate === reference));
  if (exact.length === 1) return { status: "RESOLVED", entityId: exact[0].entityId, matchedBy: "EXACT" };
  if (exact.length > 1) return { status: "UNRESOLVED", reference, reason: "AMBIGUOUS_PO" };
  const normalized = normalizePoReference(reference);
  const matches = purchaseOrders.filter((po) => [po.poNumber, ...(po.aliases ?? [])].some((candidate) => normalizePoReference(candidate) === normalized));
  if (matches.length === 1) return { status: "RESOLVED", entityId: matches[0].entityId, matchedBy: "NORMALIZED" };
  return { status: "UNRESOLVED", reference, reason: matches.length > 1 ? "AMBIGUOUS_PO" : "UNKNOWN_PO" };
}
