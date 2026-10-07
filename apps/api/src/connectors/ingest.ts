import { createHash } from "node:crypto";
import { MessageCreateSchema } from "../requests";
import type { PurchaseOrderRepository } from "../repositories/types";
import type { PurchasingAgent } from "../agent/runtime";
import { supplierForSender } from "./identity";

export interface ConnectorMessage {
  channel: "supplier_email" | "whatsapp" | "supplier_sms" | "supplier_message";
  providerMessageId: string;
  threadId?: string;
  sender: string;
  text: string;
  subject?: string;
  sentAt: string;
  receivedAt?: string;
}
/** All connectors enter through one idempotent evidence → queue boundary. */
export class ConnectorIngest {
  constructor(private store: PurchaseOrderRepository, private agent: PurchasingAgent) {}
  async receive(connectorId: string, input: ConnectorMessage, options: { queue?: boolean } = {}) {
    const org = this.agent.organizationId;
    const supplier = supplierForSender(await this.store.suppliers(org), input.sender, input.channel);
    // Do not send unrelated personal mail or unregistered phone contacts to the model.
    if (!supplier) return { status: "skipped" as const, reason: "Sender does not match one active supplier" };
    if (!Number.isFinite(Date.parse(input.sentAt))) throw new Error("Invalid supplier sent date");
    const stableId = `${connectorId}/${createHash("sha256").update(input.providerMessageId).digest("hex")}`;
    const body = MessageCreateSchema.parse({ channel: input.channel, sender: input.sender, text: input.text, subject: input.subject,
      sentAt: input.sentAt, receivedAt: input.receivedAt ?? new Date().toISOString(), externalMessageId: stableId,
      threadId: input.threadId ? `${connectorId}/${createHash("sha256").update(input.threadId).digest("hex")}` : undefined });
    const saved = await this.store.createMessage(body, org);
    if (!saved.message.supplierId) await this.store.setMessageStatus(saved.message.id, saved.message.processingStatus, { supplierId: supplier.id });
    // Queue even an existing RECEIVED record: this recovers a crash between save and enqueue.
    if (options.queue !== false && !["PROPOSAL_CREATED", "PROCESSED", "IGNORED"].includes(saved.message.processingStatus)) await this.agent.enqueue(saved.message.id, org);
    return { status: saved.status, messageId: saved.message.id };
  }
}
