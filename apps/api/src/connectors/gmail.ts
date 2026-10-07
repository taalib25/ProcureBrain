import { createHash } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import { supplierForSender } from "./identity";
import type { PurchaseOrderRepository } from "../repositories/types";
import { ConnectorRepository } from "./repository";
import { ConnectorIngest, type ConnectorMessage } from "./ingest";

interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; attachmentId?: string }; parts?: GmailPart[]; headers?: Array<{ name: string; value: string }> }
interface GmailMessage { id: string; threadId?: string; internalDate?: string; payload?: GmailPart }
/** We keep the original readable body; attachments remain explicitly unread. */
export function gmailMessage(message: GmailMessage): ConnectorMessage {
  const headers = message.payload?.headers ?? [];
  const header = (name: string) => headers.find(item => item.name.toLowerCase() === name)?.value ?? "";
  const plain: string[] = []; const html: string[] = []; const attachments: string[] = [];
  const visit = (part: GmailPart) => {
    if (part.filename || part.body?.attachmentId) { attachments.push(part.filename || part.mimeType || "file"); return; }
    if (part.body?.data) {
      const value = Buffer.from(part.body.data, "base64url").toString("utf8");
      if (part.mimeType === "text/plain") plain.push(value);
      else if (part.mimeType === "text/html") html.push(value);
    }
    part.parts?.forEach(visit);
  };
  if (message.payload) visit(message.payload);
  // HTML is stored as text, never rendered or executed. Retain raw markup as evidence when plain text is absent.
  const text = plain.join("\n") || html.join("\n") || "No readable message body.";
  const time = new Date(header("date"));
  const fallback = new Date(Number(message.internalDate));
  const sentAt = Number.isFinite(time.getTime()) ? time.toISOString() : fallback.toISOString();
  return { channel: "supplier_email", providerMessageId: message.id, threadId: message.threadId,
    sender: header("from"), receivedAt: Number.isFinite(fallback.getTime()) ? fallback.toISOString() : sentAt, subject: header("subject").slice(0, 500), sentAt,
    text: `${text}${attachments.length ? `\n\n[Unread attachments: ${attachments.join(", ")}. Attachment contents are not available.]` : ""}` };
}

export class GmailConnector {
  private client?: OAuth2Client;
  private active?: Promise<unknown>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  readonly id = "gmail";
  constructor(private repository: ConnectorRepository, private ingest: ConnectorIngest, private store: PurchaseOrderRepository, private env: NodeJS.ProcessEnv) {
    if (this.configured()) {
      this.client = new OAuth2Client(env.GMAIL_CLIENT_ID, env.GMAIL_CLIENT_SECRET);
      this.client.setCredentials({ refresh_token: env.GMAIL_REFRESH_TOKEN });
    }
  }
  private org() { return this.env.PROCUREBRAIN_AGENT_ORG ?? "org-dev"; }
  configured() { return ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"].every(key => !!this.env[key]?.trim()); }
  async status() {
    const state = await this.repository.get(this.org(), this.id);
    return { id: this.id, name: "Gmail", configured: this.configured(), enabled: this.env.PROCUREBRAIN_GMAIL_ENABLED === "true", ...state,
      mode: state.lastError ? "needs_attention" : this.configured() ? this.env.PROCUREBRAIN_GMAIL_ENABLED !== "true" ? "disabled" : state.paused ? "paused" : "reading" : "setup_needed" };
  }
  async pause(paused: boolean) { await this.repository.patch(this.org(), this.id, { paused }); return this.status(); }
  start() {
    this.stopped = false;
    const run = () => { if (!this.stopped) void this.sync().catch(() => {}); };
    this.timer = setInterval(run, 60000); this.timer.unref(); run();
  }
  async close() { this.stopped = true; if (this.timer) clearInterval(this.timer); await this.active; }
  async sync() {
    if (this.active) return this.active;
    if (!this.client || this.env.PROCUREBRAIN_GMAIL_ENABLED !== "true" || this.stopped) return { status: "not_enabled" };
    this.active = this.repository.exclusive(this.org(), this.id, () => this.cycle()).finally(() => { this.active = undefined; });
    return this.active;
  }
  private async request<T>(path: string): Promise<T> {
    const response = await this.client!.request<T>({ url: `https://gmail.googleapis.com/gmail/v1/users/me/${path}`, timeout: 20000, retry: false });
    return response.data;
  }
  private async cycle() {
    let state = await this.repository.get(this.org(), this.id);
    if (state.paused) return { status: "paused" };
    try {
      const suppliers = (await this.store.suppliers(this.org())).filter(item => item.status === "active");
      const contacts = suppliers.flatMap(supplier => {
        if (supplier.primaryEmail && /^[^\s{}:]+@[^\s{}:]+$/.test(supplier.primaryEmail)) return [`from:${supplier.primaryEmail}`];
        const domain = supplier.emailDomain?.toLowerCase();
        return domain && /^[a-z0-9.-]+$/.test(domain) && !["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com"].includes(domain) ? [`from:(@${domain})`] : [];
      });
      if (!contacts.length) { await this.repository.patch(this.org(), this.id, { lastError: "Add supplier email addresses before reading Gmail." }); return { status: "no_suppliers" }; }
      if (contacts.join(" ").length > 4000) throw new Error("Supplier query is too large");
      const contactsHash = createHash("sha256").update(contacts.sort().join("|")).digest("hex");
      const profile = await this.request<{ emailAddress: string; historyId: string }>("profile");
      if (state.contactsHash !== contactsHash || state.accountEmail !== profile.emailAddress) state = await this.repository.patch(this.org(), this.id,
        { cursor: "", pageToken: "", bootstrapHistoryId: profile.historyId, bootstrapped: false, contactsHash, accountEmail: profile.emailAddress });
      const historical = !state.bootstrapped;
      let ids: string[]; let next: string | undefined; let checkpoint: string | undefined;
      if (historical) {
        const query = new URLSearchParams({ q: `newer_than:14d {${contacts.join(" ")}}`, maxResults: "25", ...(state.pageToken ? { pageToken: state.pageToken } : {}) });
        const result = await this.request<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(`messages?${query}`);
        ids = result.messages?.map(message => message.id) ?? []; next = result.nextPageToken; checkpoint = state.bootstrapHistoryId ?? profile.historyId;
      } else {
        const query = new URLSearchParams({ startHistoryId: state.cursor!, historyTypes: "messageAdded", maxResults: "20", ...(state.pageToken ? { pageToken: state.pageToken } : {}) });
        let result: { history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; nextPageToken?: string; historyId: string };
        try { result = await this.request(`history?${query}`); }
        catch (error) {
          if ((error as { response?: { status?: number } }).response?.status === 404) {
            await this.repository.patch(this.org(), this.id, { bootstrapped: false, cursor: "", pageToken: "", bootstrapHistoryId: profile.historyId });
            return { status: "history_expired", message: "Reading recent supplier history again before resuming new messages." };
          }
          throw error;
        }
        ids = [...new Set(result.history?.flatMap(history => history.messagesAdded?.map(item => item.message.id) ?? []) ?? [])];
        next = result.nextPageToken; checkpoint = result.historyId;
      }
      let imported = 0; let skipped = 0;
      for (const id of ids) {
        if ((await this.repository.get(this.org(), this.id)).paused || this.stopped) return { status: "paused" }; // Keep checkpoint; safe replay resumes this page.
        let message: GmailMessage;
        try {
          const metadata = await this.request<GmailMessage>(`messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From`);
          const sender = metadata.payload?.headers?.find(header => header.name.toLowerCase() === "from")?.value ?? "";
          if (!supplierForSender(suppliers, sender, "supplier_email")) { skipped++; continue; }
          message = await this.request(`messages/${encodeURIComponent(id)}?format=full`);
        }
        catch (error) { if ((error as { response?: { status?: number } }).response?.status === 404) { skipped++; continue; } throw error; }
        const result = await this.ingest.receive(`gmail:${createHash("sha256").update(profile.emailAddress).digest("hex").slice(0, 16)}`, gmailMessage(message), { queue: !historical });
        if (result.status === "created") imported++; else if (result.status === "skipped") skipped++;
      }
      await this.repository.patch(this.org(), this.id, { pageToken: next ?? "", ...(next ? {} : { cursor: checkpoint, bootstrapped: true }),
        lastSyncAt: new Date().toISOString(), lastError: null, imported: (state.imported ?? 0) + imported, skipped: (state.skipped ?? 0) + skipped });
      return { status: next ? "more_history" : "up_to_date", imported, skipped, historical };
    } catch {
      // Never return provider exceptions: they can carry OAuth tokens and private response bodies.
      await this.repository.patch(this.org(), this.id, { lastError: "Gmail could not be read. Check the connection settings or reconnect the account." });
      return { status: "failed" };
    }
  }
}
