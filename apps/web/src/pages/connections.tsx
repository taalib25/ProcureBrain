import { useState } from "react";
import { dateLabel, errorText, post, useResource } from "../api";
import { Badge, Notice, PanelHeading } from "../components/ui";

type ConnectionsData = { gmail: { configured: boolean; enabled?: boolean; mode: string; accountEmail?: string; paused?: boolean; lastSyncAt?: string; lastError?: string | null; bootstrapped?: boolean }; whatsapp: { configured: boolean; enabled: boolean }; other: { configured: boolean } };
export function Connections({ revision }: { revision: number }) {
  const [localRevision, setLocalRevision] = useState(0);
  const { data, error } = useResource<ConnectionsData>("/connectors", revision + localRevision);
  const [busy, setBusy] = useState(false); const [actionError, setActionError] = useState(""); const [notice, setNotice] = useState("");
  const action = async (name: "sync" | "pause" | "resume") => {
    setBusy(true); setActionError(""); setNotice("");
    try {
      const result = await post<{ status?: string; historical?: boolean; imported?: number }>(`/connectors/gmail/${name}`);
      setNotice(name === "pause" ? "Gmail reading is paused. Messages already saved stay in the app." : name === "resume" ? "Gmail reading will resume on the next check." : result.status === "failed" ? "Gmail could not be read. Check the connection settings." : result.status === "not_enabled" ? "Gmail reading is not enabled. Ask the person who set up the app for help." : result.status === "no_suppliers" ? "Add supplier email addresses first." : result.status === "paused" ? "Resume Gmail reading before checking for messages." : result.status === "busy" ? "A message check is already running." : result.status === "history_expired" ? "Recent supplier history will be read again before checking new messages." : `${result.imported ?? 0} new supplier messages saved.${result.historical ? " These past messages are saved as history. New messages will be checked automatically after the history finishes loading." : ""}`);
      setLocalRevision(value => value + 1);
    } catch (error) { setActionError(errorText(error)); } finally { setBusy(false); }
  };
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="loading-label">Loading connections…</p>;
  const gmail = data.gmail;
  const gmailLabel = gmail.mode === "reading" ? "Reading supplier messages" : gmail.mode === "paused" ? "Paused" : gmail.mode === "needs_attention" ? "Needs attention" : gmail.mode === "disabled" ? "Gmail reading is off" : "Setup needed";
  return <div className="form-stack">
    <Notice>Connected channels bring supplier messages into this app. New messages go to the AI service for checking. You decide whether to update an order. No replies are sent to suppliers.</Notice>
    <section className="panel"><PanelHeading title="Gmail" subtitle="Read supplier emails without copying and pasting" action={<Badge value={gmail.mode === "reading" ? "active" : gmail.mode === "needs_attention" ? "REVIEW_REQUIRED" : "PENDING"}>{gmailLabel}</Badge>}/><div className="panel-body form-stack">
      {gmail.accountEmail && <p><strong>Connected account:</strong> {gmail.accountEmail}</p>}
      <p>We save messages from suppliers in your supplier list. Add their email addresses first. Gmail is checked every minute while the app service runs.</p>
      <p className="field-help">The first connection loads two weeks of supplier messages as history. New messages are checked automatically after history finishes loading. You can check a past message yourself from Messages.</p>
      {gmail.configured ? <><p className="field-help">{gmail.lastSyncAt ? `Last check: ${dateLabel(gmail.lastSyncAt, true)} · ${new Date(gmail.lastSyncAt).toLocaleTimeString()}` : "No completed Gmail check yet."} {gmail.bootstrapped === false && "Recent history is still loading."}</p>{gmail.lastError && <Notice tone="error">{gmail.lastError}</Notice>}<div className="actions"><button className="button button-primary" disabled={busy || !gmail.enabled || !!gmail.paused} onClick={() => void action("sync")}>{busy ? "Working…" : "Check for new messages"}</button><button className="button button-secondary" disabled={busy} onClick={() => void action(gmail.paused ? "resume" : "pause")}>{gmail.paused ? "Resume reading" : "Pause reading"}</button></div>{!gmail.enabled && <Notice>Gmail reading is disabled in the app settings. Ask the person who set up the app to enable it.</Notice>}</> : <details className="optional-details"><summary>How to connect Gmail</summary><p>Ask the person who set up this app to register it with Google. Then use the setup command to open Google’s permission screen.</p><p>You will sign in to Google and grant read access. Google grants mailbox read permission; ProcureBrain stores only messages that match one registered supplier.</p><p className="field-help">For the app maintainer: set the Google client settings in the local .env, then run <code>pnpm --filter @procurebrain/api connect:gmail</code>. Follow docs/CONNECTED_CHANNELS.md. Restart the API after connecting.</p></details>}
      {notice && <Notice>{notice}</Notice>}{actionError && <Notice tone="error">{actionError}</Notice>}
    </div></section>
    <section className="panel"><PanelHeading title="WhatsApp Business" subtitle="Receive supplier text messages through the official business connection" action={<Badge value={data.whatsapp.enabled && data.whatsapp.configured ? "active" : "PENDING"}>{data.whatsapp.enabled && data.whatsapp.configured ? "Receiver enabled" : "Setup needed"}</Badge>}/><div className="panel-body"><p>The text-message receiver is built. It needs your WhatsApp Business account and a reachable app address. It reads messages only from supplier phone numbers in your list.</p><p className="field-help">Personal WhatsApp chat history, voice notes, images, and documents are not connected. WhatsApp replies and alerts are not enabled.</p><details className="optional-details"><summary>Setup details</summary><p className="field-help">The app maintainer configures the business phone ID, verification token, app secret, and signed webhook. See docs/CONNECTED_CHANNELS.md.</p></details></div></section>
    <section className="panel"><PanelHeading title="Other message sources" subtitle="Bring messages from another service through a signed connection"/><div className="panel-body"><p>An app maintainer can connect a forwarding service or another system to the shared message receiver. Each message keeps its sender, original text, sent date, and message ID.</p><p className="field-help">{data.other.configured ? "The signed receiver is configured. Individual services still need to be connected." : "The receiver needs setup. Outlook and other ready-made account connections are not built yet."}</p></div></section>
  </div>;
}
