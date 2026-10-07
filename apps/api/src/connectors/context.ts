import type { CommunicationContext } from "../../../../packages/ai/src/communication-context";
import type { PurchaseOrderRepository } from "../repositories/types";
import type { Supplier, SupplierMessage } from "../store";
import { supplierForSender } from "./identity";
import { normalizePoReference } from "../../../../packages/ingestion/src";

const messageTime = (message: SupplierMessage) => message.sentAt ?? message.receivedAt;
export async function communicationContext(store: PurchaseOrderRepository, message: SupplierMessage, supplier: Supplier | undefined, entityId: string, poNumber: string): Promise<CommunicationContext> {
  const all = await store.listMessages(message.organizationId);
  const suppliers = await store.suppliers(message.organizationId);
  const sameSupplier = all.filter(item => item.id !== message.id && supplier && (item.supplierId === supplier.id || supplierForSender(suppliers, item.sender, item.channel)?.id === supplier.id));
  const relevant: SupplierMessage[] = [];
  for (const prior of sameSupplier) {
    const selected = (await store.getMessageCandidates(prior.id)).find(candidate => candidate.isSelected);
    const references = `${prior.subject ?? ""}\n${prior.text}`.match(/\bPO[- #]?[A-Z0-9][A-Z0-9-]*\b/gi) ?? [];
    if (selected && selected.entityId !== entityId) continue;
    if (references.length && !references.some(reference => normalizePoReference(reference) === normalizePoReference(poNumber))) continue;
    if (selected?.entityId === entityId || references.some(reference => normalizePoReference(reference) === normalizePoReference(poNumber)) || (message.threadId && prior.threadId === message.threadId)) relevant.push(prior);
  }
  const time = Date.parse(messageTime(message));
  const earlier = relevant.filter(prior => Date.parse(messageTime(prior)) <= time).sort((a, b) => Date.parse(messageTime(a)) - Date.parse(messageTime(b))).slice(-8);
  const events = [...await store.timeline(entityId)].filter(event => Date.parse(event.occurredAt) <= time).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)).slice(-12);
  return { currentMessage: { sentAt: message.sentAt ?? message.receivedAt, receivedAt: message.receivedAt, timezone: process.env.PROCUREBRAIN_TIMEZONE ?? "Asia/Colombo", subject: message.subject, threadId: message.threadId },
    supplier: supplier ? { id: supplier.id, name: supplier.name, email: supplier.primaryEmail, phone: supplier.phone } : null,
    previousMessages: earlier.map(prior => ({ sourceRecordId: prior.sourceRecordId, channel: prior.channel, sentAt: messageTime(prior), text: prior.text.slice(0, 1500), truncated: prior.text.length > 1500 })),
    orderHistory: events.map(event => ({ sourceRecordId: event.sourceRecordId, eventType: event.eventType, occurredAt: event.occurredAt, eta: "eta" in event.payload && typeof event.payload.eta === "string" ? event.payload.eta : null, quantity: "quantity" in event.payload && typeof event.payload.quantity === "number" ? event.payload.quantity : null })),
    olderThanKnownUpdate: relevant.some(prior => Date.parse(messageTime(prior)) > time && ["PROPOSAL_CREATED", "PROCESSED"].includes(prior.processingStatus)) };
}

/** A supplier overview is derived from saved evidence, never a fabricated reliability score. */
export async function supplierHistory(store: PurchaseOrderRepository, org: string, supplier: Supplier) {
  const suppliers = await store.suppliers(org);
  const messages = (await store.listMessages(org)).filter(message => message.supplierId === supplier.id || supplierForSender(suppliers, message.sender, message.channel)?.id === supplier.id);
  const orders = await store.supplierPurchaseOrders(supplier.id, org);
  const proposals = (await store.listProposals(org)).filter(proposal => orders.some(order => order.entityId === proposal.entityId));
  const events = (await Promise.all(orders.map(async order => (await store.timeline(order.entityId)).map(event => ({ ...event, orderId: order.entityId }))))).flat();
  const timeline = [
    ...messages.map(message => ({ kind: "message", id: message.id, occurredAt: messageTime(message), receivedAt: message.receivedAt, title: message.subject ?? "Supplier message", text: message.text, channel: message.channel, sourceRecordId: message.sourceRecordId, threadId: message.threadId })),
    ...events.map(event => ({ kind: "order", id: event.id, occurredAt: event.occurredAt, title: event.eventType, orderId: event.orderId, sourceRecordId: event.sourceRecordId, payload: event.payload })),
  ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  return { supplier, summary: { savedMessages: messages.length, openOrders: orders.filter(order => order.status !== "RECEIVED").length,
    pendingChanges: proposals.filter(proposal => proposal.status === "PENDING").length, lastMessageAt: messages.map(messageTime).sort().at(-1) ?? null,
    channels: [...new Set(messages.map(message => message.channel))] }, timeline: timeline.slice(0, 200), truncated: timeline.length > 200 };
}
