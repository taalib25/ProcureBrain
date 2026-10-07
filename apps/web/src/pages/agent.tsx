import { useEffect, useState } from "react";
import { dateLabel, errorText, post, useResource } from "../api";
import { Badge, Empty, Notice, PanelHeading, RawDetails } from "../components/ui";

type Work = { id: string; kind: string; status: string; attempts: number; createdAt: string; payload: { messageId?: string; subject?: string; text?: string; proposalId?: string; error?: string; providerId?: string } };
type AgentData = { configuration: { emailMode: string; missing: string[]; deliveryEnabled: boolean }; work: Work[] };
const progressLabel = (work: Work) => ({
  QUEUED: work.kind === "email" ? "Waiting to send" : "Waiting to be checked",
  PROCESSING: work.kind === "email" ? "Sending" : "Checking message",
  COMPLETED: work.payload.proposalId ? "Change ready to check" : "Message checked",
  NEEDS_REVIEW: "Needs your help", FAILED: "Could not finish",
  AWAITING_CONFIGURATION: "Preview only", ACCEPTED: "Sent to email service",
}[work.status] ?? "Status unavailable");

export function AgentActivity({ onReview, search }: { onReview: (id: string) => void; search: string }) {
  const [revision, setRevision] = useState(0);
  const { data, error } = useResource<AgentData>("/agent", revision);
  useEffect(() => { const timer = setInterval(() => setRevision(value => value + 1), 5000); return () => clearInterval(timer); }, []);
  const [retryError, setRetryError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const retry = async (id: string) => {
    setRetrying(true); setRetryError("");
    try { await post(`/agent/emails/${encodeURIComponent(id)}/retry`); setRevision(value => value + 1); }
    catch (error) { setRetryError(errorText(error)); }
    finally { setRetrying(false); }
  };
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return <p className="loading-label">Loading email alerts…</p>;
  const matches = (work: Work) => JSON.stringify(work.payload).toLowerCase().includes(search.toLowerCase());
  const emails = data.work.filter(work => work.kind === "email" && matches(work));
  const messages = data.work.filter(work => work.kind === "message" && matches(work));
  const email = emails.find(work => work.id === selected) ?? emails[0];
  const live = data.configuration.emailMode === "live";
  return <div className="form-stack">
    <Notice>{live ? "Email alerts are on. This app shows when the email service accepts an alert. It cannot confirm inbox delivery." : "Email alerts are off. You can read saved email previews here. No email is sent."}</Notice>
    <section className="panel"><PanelHeading title="How alerts work" subtitle="Read supplier message → check change → update order"/><div className="panel-body"><p>Messages from connected channels are checked automatically. You can also add and check a message yourself. We prepare an alert when a change needs checking or we need your help.</p><p className="field-help">You must approve an order update. Open Connections to set up Gmail or WhatsApp Business.</p>{!live && <details className="optional-details"><summary>How to turn on email alerts</summary><p>Ask the person who set up this app to connect email delivery and set your email address.</p><RawDetails value={data.configuration} label="Email setup details for the app maintainer"/></details>}</div></section>
    <div className="split-workspace">
      <section className="panel"><PanelHeading title="Message progress" subtitle={`${messages.length} saved ${messages.length === 1 ? "message check" : "message checks"}`}/>{messages.length ? <div className="message-list">{messages.map(message => <div className="message-item" key={message.id}><div className="message-item-top"><strong>{message.payload.subject ?? "Supplier message"}</strong><Badge value={message.status}>{progressLabel(message)}</Badge></div><p>{message.status === "FAILED" ? "We could not check this message. Open Messages to try again. If this continues, ask the person who set up the app for help." : message.status === "NEEDS_REVIEW" ? "Open Messages to read the update and choose the order. Read the email preview for more details." : message.payload.proposalId ? "Read the supplier message before you update the order." : message.status === "COMPLETED" ? "The check is finished. See Messages for the result." : "This page updates as we check your message."}</p><small>{dateLabel(message.createdAt, true)}</small>{message.payload.proposalId && <button className="button button-secondary button-small" onClick={() => onReview(message.payload.proposalId!)}>Check change</button>}<RawDetails value={message} label="Technical details"/></div>)}</div> : <Empty title="No messages checked yet">Select Add message. Paste a supplier update and select Check message.</Empty>}</section>
      <section className="panel"><PanelHeading title={live ? "Your email alerts" : "Email previews"} subtitle={`${emails.length} saved ${emails.length === 1 ? "alert" : "alerts"}`}/>{emails.length ? <div className="panel-body form-stack"><label>Choose an alert<select value={email?.id ?? ""} onChange={event => setSelected(event.target.value)}>{emails.map(item => <option key={item.id} value={item.id}>{item.payload.subject ?? "Supplier alert"}</option>)}</select></label>{email && <><Badge value={email.status}>{progressLabel(email)}</Badge><h3>{email.payload.subject}</h3><div className="message-body">{email.payload.text}</div>{email.payload.error && <Notice tone="error">This email could not be sent. Try again. If this continues, ask the person who set up the app for help.</Notice>}{email.status === "FAILED" && <button className="button button-secondary" disabled={retrying} onClick={() => void retry(email.id)}>{retrying ? "Saving…" : "Try sending again"}</button>}{retryError && <Notice tone="error">{retryError}</Notice>}{email.payload.proposalId && <button className="button button-primary" onClick={() => onReview(email.payload.proposalId!)}>Check change</button>}<p className="field-help">{email.status === "ACCEPTED" ? "The email service accepted this alert. Inbox delivery is not confirmed." : email.status === "AWAITING_CONFIGURATION" ? "This is a saved preview. No email has been sent." : email.status === "FAILED" ? "Sending stopped. Use Try sending again to request another attempt." : live ? "This alert will be sent while the app service is running." : "Email alerts are off. This alert will be saved as a preview."}</p><RawDetails value={email} label="Technical details"/></>}</div> : <Empty title="No email alerts yet">An alert appears when an order change needs checking or a message needs your help.</Empty>}</section>
    </div>
  </div>;
}
