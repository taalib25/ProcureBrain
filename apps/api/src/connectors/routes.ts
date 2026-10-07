import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hono, Context } from "hono";
import { z } from "zod";
import type { PurchaseOrderRepository } from "../repositories/types";
import type { GmailConnector } from "./gmail";
import type { ConnectorIngest } from "./ingest";
import { supplierHistory } from "./context";

export interface Connectors { gmail: GmailConnector; ingest: ConnectorIngest; env: NodeJS.ProcessEnv }
const equal = (a: string, b: string) => { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
const validSignature = (body: Uint8Array, signature: string | undefined, secret: string, prefix = "") => {
  const expected = createHmac("sha256", secret).update(prefix).update(body).digest("hex");
  return !!signature && /^sha256=[a-f0-9]{64}$/.test(signature) && equal(signature.slice(7), expected);
};
const MetaMessage = z.object({ id: z.string().min(1), from: z.string().min(1), timestamp: z.string().regex(/^\d+$/), type: z.string(),
  text: z.object({ body: z.string() }).optional(), document: z.object({ filename: z.string().optional(), caption: z.string().optional() }).optional(),
  image: z.object({ caption: z.string().optional() }).optional() }).passthrough();
const MetaBody = z.object({ object: z.literal("whatsapp_business_account"), entry: z.array(z.object({ changes: z.array(z.object({
  field: z.string(), value: z.object({ metadata: z.object({ phone_number_id: z.string() }).optional(), messages: z.array(MetaMessage).max(100).optional() }).passthrough(),
}).passthrough()) }).passthrough()).max(100) }).passthrough();
const GenericMessage = z.object({ providerMessageId: z.string().min(1).max(500), threadId: z.string().max(500).optional(), channel: z.enum(["supplier_email", "whatsapp", "supplier_sms", "supplier_message"]),
  sender: z.string().min(1).max(320), text: z.string().min(1).max(200000), subject: z.string().max(500).optional(), sentAt: z.string().datetime({ offset: true }), receivedAt: z.string().datetime({ offset: true }).optional() }).strict();

async function bodyBytes(request: Request): Promise<Uint8Array | null> {
  if (Number(request.headers.get("content-length") ?? 0) > 1048576) return null;
  const reader = request.body?.getReader(); if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1048576) { await reader.cancel(); return null; } chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}

export function connectorRoutes(app: Hono, store: PurchaseOrderRepository, connectors: Connectors | undefined, organization: (context: Context) => string | null) {
  app.get("/api/suppliers/:id/history", async c => {
    const org = organization(c); if (!org) return c.json({ error: "Invalid organization" }, 400);
    const supplier = await store.supplier(c.req.param("id"), org);
    return supplier ? c.json(await supplierHistory(store, org, supplier)) : c.json({ error: "Supplier not found" }, 404);
  });
  app.get("/api/connectors", async c => {
    if (connectors && organization(c) !== (connectors.env.PROCUREBRAIN_AGENT_ORG ?? "org-dev")) return c.json({ error: "Connection unavailable for these orders" }, 403);
    return c.json({ gmail: connectors ? await connectors.gmail.status() : { configured: false, mode: "setup_needed" },
    whatsapp: { configured: !!(connectors?.env.WHATSAPP_APP_SECRET && connectors.env.WHATSAPP_VERIFY_TOKEN && connectors.env.WHATSAPP_PHONE_NUMBER_ID),
      enabled: connectors?.env.PROCUREBRAIN_WHATSAPP_ENABLED === "true", kind: "business_platform", textOnly: true },
    other: { configured: (connectors?.env.PROCUREBRAIN_INBOUND_SECRET?.length ?? 0) >= 32 }, storage: connectors ? "server" : "unavailable" });
  });
  for (const action of ["sync", "pause", "resume"] as const) app.post(`/api/connectors/gmail/${action}`, async c => {
    if (!connectors || organization(c) !== (connectors.env.PROCUREBRAIN_AGENT_ORG ?? "org-dev")) return c.json({ error: "Connection unavailable for these orders" }, 403);
    const origin = c.req.header("origin");
    if (origin) {
      let expected: string; try { expected = new URL(connectors.env.PROCUREBRAIN_WEB_URL ?? "http://localhost:5173").origin; } catch { return c.json({ error: "Invalid app URL" }, 503); }
      if (origin !== expected) return c.json({ error: "This action must come from the app" }, 403);
    }
    return c.json(action === "sync" ? await connectors.gmail.sync() ?? { status: "busy" } : await connectors.gmail.pause(action === "pause"));
  });
  app.get("/api/connectors/whatsapp/webhook", c => {
    const token = connectors?.env.WHATSAPP_VERIFY_TOKEN;
    if (!token || c.req.query("hub.mode") !== "subscribe" || !equal(c.req.query("hub.verify_token") ?? "", token)) return c.text("Verification failed", 403);
    const challenge = c.req.query("hub.challenge"); return challenge && challenge.length < 200 ? c.text(challenge) : c.text("Missing challenge", 400);
  });
  app.post("/api/connectors/whatsapp/webhook", async c => {
    if (!connectors || connectors.env.PROCUREBRAIN_WHATSAPP_ENABLED !== "true" || !connectors.env.WHATSAPP_APP_SECRET || !connectors.env.WHATSAPP_PHONE_NUMBER_ID) return c.json({ error: "WhatsApp is not enabled" }, 503);
    const raw = await bodyBytes(c.req.raw); if (!raw) return c.json({ error: "Request body too large" }, 413);
    if (!validSignature(raw, c.req.header("x-hub-signature-256"), connectors.env.WHATSAPP_APP_SECRET)) return c.json({ error: "Invalid webhook signature" }, 401);
    let input: unknown; try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid webhook body" }, 400); }
    const parsed = MetaBody.safeParse(input); if (!parsed.success) return c.json({ error: "Invalid WhatsApp event" }, 400);
    let received = 0; let skipped = 0;
    for (const entry of parsed.data.entry) for (const change of entry.changes) {
      if (change.field !== "messages" || change.value.metadata?.phone_number_id !== connectors.env.WHATSAPP_PHONE_NUMBER_ID) continue;
      for (const message of change.value.messages ?? []) {
        const date = new Date(Number(message.timestamp) * 1000); if (!Number.isFinite(date.getTime())) { skipped++; continue; }
        if (message.type !== "text" || !message.text?.body.trim()) { skipped++; continue; }
        const result = await connectors.ingest.receive(`whatsapp:${connectors.env.WHATSAPP_PHONE_NUMBER_ID}`, { channel: "whatsapp", providerMessageId: message.id,
          sender: message.from, threadId: message.from, sentAt: date.toISOString(), text: message.text.body });
        if (result.status === "skipped") skipped++; else received++;
      }
    }
    return c.json({ received, skipped });
  });
  app.post("/api/connectors/webhook/:name", async c => {
    const secret = connectors?.env.PROCUREBRAIN_INBOUND_SECRET;
    if (!connectors || !secret || secret.length < 32) return c.json({ error: "Inbound connection is not configured" }, 503);
    const name = c.req.param("name"); if (!/^[a-z0-9-]{1,40}$/.test(name)) return c.json({ error: "Invalid connection name" }, 400);
    const timestamp = c.req.header("x-procurebrain-timestamp") ?? "";
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000) return c.json({ error: "Expired request" }, 401);
    const raw = await bodyBytes(c.req.raw); if (!raw) return c.json({ error: "Request body too large" }, 413);
    if (!validSignature(raw, c.req.header("x-procurebrain-signature"), secret, `${timestamp}.`)) return c.json({ error: "Invalid webhook signature" }, 401);
    let input: unknown; try { input = JSON.parse(new TextDecoder().decode(raw)); } catch { return c.json({ error: "Invalid webhook body" }, 400); }
    const parsed = GenericMessage.safeParse(input); if (!parsed.success) return c.json({ error: "Invalid supplier message" }, 400);
    return c.json(await connectors.ingest.receive(`webhook:${name}`, parsed.data), 202);
  });
}
