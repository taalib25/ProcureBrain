import { useEffect, useState } from "react";

/** All screens share response handling; HTTP errors never masquerade as empty data. */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, options);
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("The app could not read the response. Try again. If this continues, ask the person who set up the app for help."); }
  if (!response.ok) {
    const error = body as { error?: string; configurationError?: string };
    throw new Error(plainError(error.error ?? error.configurationError ?? `Request failed (${response.status}).`));
  }
  return body as T;
}
export const post = <T,>(path: string, body: unknown = {}) => api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Cancel obsolete requests when a different order, message, or proposal is selected. */
export function useResource<T>(path: string | null, revision = 0) {
  const [resource, setResource] = useState<{ path: string | null; data?: T; error?: string }>({ path: null });
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) { setResource({ path: null }); setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    void api<T>(path, { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResource({ path, data });
    }).catch(error => {
      if (!controller.signal.aborted) setResource({ path, error: error instanceof Error ? error.message : "Could not load this record." });
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, revision]);
  return { data: resource.path === path ? resource.data : undefined, error: resource.path === path ? resource.error : undefined, loading };
}

function plainError(message: string): string {
  const copy: Record<string, string> = {
    "AI provider is not configured": "Message checking is not set up. Ask the person who set up the app to connect the AI service.",
    "No extraction provider configured": "Message checking is not set up. Ask the person who set up the app for help.",
    "Agent runtime unavailable": "Message checking is unavailable. Ask the person who set up the app to start the service.",
    "Agent not configured for this workspace": "Message checking is not set up for these orders. Ask the person who set up the app for help.",
    "Invalid supplier message": "Check the message text, sender details, and sent date. Then try again.",
    "Invalid supplier request": "Check the supplier name, code, and email address. Then try again.",
    "Invalid sentAt": "Enter a valid date and time for the supplier message.",
    "This message is already being analyzed or has a saved analysis": "This message is being checked or was already checked. Open the saved result.",
    "Wait for the queued analysis to finish before changing its order match": "Wait for this message check to finish before choosing another order.",
    "This proposal needs more information before it can be approved": "We need more information before you can update the order. Check the supplier message.",
    "The PO number in the message does not match the selected purchase order": "The order number in the message is different from the order you chose. Check the original message.",
    "This proposal was rejected": "You already declined this change. The order stays the same.",
    "There is no valid supplier proposal to approve": "No change is ready to approve. Check the supplier message.",
    "There is no extracted supplier update to approve": "No change is ready to approve. Check the supplier message.",
    "Select a purchase order and analyze the supplier message again before approving": "Choose the correct order in Messages. Then check the message again.",
    "No failed email found": "This email cannot be sent again from here. Refresh to see its current status.",
    "Request body too large": "The message or file is too large. Choose a smaller file or shorten the message.",
    "Failed to fetch": "The app cannot connect. Try again. If this continues, ask the person who set up the app for help.",
  };
  return copy[message] ?? message;
}
export const errorText = (error: unknown) => error instanceof Error ? plainError(error.message) : "Something went wrong. Please try again.";
export const orderName = (po: { entityId: string; poReference?: string }) => po.poReference ?? po.entityId;
export function dateLabel(value: string | null | undefined, includeYear = false): string {
  if (!value) return "Not set";
  const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", ...(includeYear ? { year: "numeric" as const } : {}), ...(value.length === 10 ? { timeZone: "UTC" } : {}) }).format(date);
}
export function daysBetween(from: string | null | undefined, to: string | null | undefined) {
  if (!from || !to) return null;
  const value = Math.round((Date.parse(`${to.slice(0, 10)}T00:00:00Z`) - Date.parse(`${from.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  return Number.isFinite(value) ? value : null;
}
export const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
/** Keep internal status codes out of the everyday purchasing workflow. */
const labels: Record<string, string> = {
  PENDING: "Waiting for your decision", APPLIED: "Order updated", REJECTED: "Change declined",
  STALE: "Outdated — check latest message", REVIEW_REQUIRED: "Needs your help", PROPOSAL_CREATED: "Change ready to check",
  PROCESSED: "Checked", ANALYZING: "Checking message", FAILED: "Could not finish", NEEDS_REVIEW: "Needs your help", QUEUED: "Waiting to be checked",
  RUNNING: "Checking", PROCESSING: "Checking", COMPLETED: "Finished", PREVIEW_READY: "Preview only", AWAITING_CONFIGURATION: "Email setup needed",
  ACCEPTED: "Sent to email service", VALID: "Ready to check", LOW_CONFIDENCE: "Check carefully",
  INVALID_SCHEMA: "Could not read the change", UNKNOWN_PO: "Order not found", AMBIGUOUS_PO: "Choose the correct order",
  DUPLICATE_SOURCE: "Message already used", PARTIALLY_RECEIVED: "Some goods received", PO_CREATED: "Order added",
  SUPPLIER_UPDATE: "Supplier update saved", ETA_CHANGED: "Delivery date changed", ETA_CHANGE: "Delivery date change",
  QUANTITY_CHANGE: "Quantity change", GOODS_RECEIVED: "Goods received", FOLLOW_UP: "Supplier follow-up saved",
};
export const readable = (value: string) => labels[value] ?? value.toLowerCase().replaceAll("_", " ").replace(/^./, char => char.toUpperCase()).replace(/\bPo\b/g, "order").replace(/\bEta\b/g, "delivery date");
export const channelLabel = (value: string) => ({ supplier_message: "Pasted note", supplier_email: "Email", supplier_sms: "SMS", whatsapp: "WhatsApp", supplier_image: "Image", supplier_pdf: "PDF", purchase_orders: "Order import", supplier_updates: "Supplier update", receipts: "Receipt import", followups: "Follow-up import", csv: "CSV" }[value] ?? readable(value));
