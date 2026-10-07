import { useEffect, useState, type FormEvent } from "react";
import { channelLabel, dateLabel, errorText, orderName, post, readable, useResource } from "../api";
import { Badge, Empty, Icon, Modal, Notice, PanelHeading, RawDetails } from "../components/ui";
import type { Candidate, ChangeProposal, Extraction, PO, Run, SupplierMessage } from "../types";

export type CaptureDraft = { channel: string; sender: string; subject: string; text: string; sentAt?: string; externalMessageId?: string };

type MessageDetailData = { message: SupplierMessage; candidates: Candidate[]; proposal: Extraction | null };


export function CaptureMessage({ orders, initialOrderId, initialMessage, onClose, onSaved }: { orders: PO[]; initialOrderId?: string; initialMessage?: CaptureDraft; onClose: () => void; onSaved: (id: string) => void }) {
  const [channel, setChannel] = useState(initialMessage?.channel ?? "supplier_message");
  const [sender, setSender] = useState(initialMessage?.sender ?? ""); const [subject, setSubject] = useState(initialMessage?.subject ?? ""); const [text, setText] = useState(initialMessage?.text ?? ""); const [sentAt, setSentAt] = useState(initialMessage?.sentAt ? new Date(Date.parse(initialMessage.sentAt) - new Date(initialMessage.sentAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""); const [orderId, setOrderId] = useState(initialOrderId ?? "");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const analyze = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") !== "save";
    setBusy(true); setError("");
    let id = savedId;
    try {
      if (!id) {
        const result = await post<{ message: SupplierMessage }>("/messages", { channel, text, ...(initialMessage?.externalMessageId ? { externalMessageId: initialMessage.externalMessageId } : {}), ...(sender.trim() ? { sender: sender.trim() } : {}), ...(subject.trim() ? { subject: subject.trim() } : {}), ...(sentAt ? { sentAt: new Date(sentAt).toISOString() } : {}) });
        id = result.message.id; setSavedId(id);
      }
      if (orderId) await post(`/messages/${encodeURIComponent(id)}/link-purchase-order`, { entityId: orderId });
      if (analyze) await post(`/messages/${encodeURIComponent(id)}/queue`);
      onSaved(id);
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  return <Modal title="Add a supplier message" description="Paste the full message. We will look for the order and any changes." onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => void save(event)} className="form-stack">
      <label>Supplier message<textarea value={text} disabled={busy || !!savedId} required onChange={event => setText(event.target.value)} placeholder="Paste the message here. Include the order number if you have it." rows={6}/></label>
      <label>Which order is this for? <span className="optional">(optional)</span><select value={orderId} disabled={busy} onChange={event => setOrderId(event.target.value)}><option value="">Find the order from the message</option>{orders.map(po => <option key={po.entityId} value={po.entityId}>{orderName(po)} · {po.supplierName ?? "Unknown supplier"}</option>)}</select></label>
      {channel !== "supplier_message" && <label>Who sent it?<input value={sender} required disabled={busy || !!savedId} maxLength={320} placeholder={channel === "supplier_email" ? "Supplier email address" : "Supplier phone number"} onChange={event => setSender(event.target.value)}/></label>}
      <details className="optional-details"><summary>Add message details <span className="optional">(optional)</span></summary><div className="form-stack">
        <label>Where did you receive it?<select value={channel} disabled={busy || !!savedId} onChange={event => setChannel(event.target.value)}><option value="supplier_message">Pasted message or note</option><option value="supplier_email">Email</option><option value="whatsapp">WhatsApp</option><option value="supplier_sms">Text message</option></select></label>
        <p className="field-help">This records where the message came from. Copy and paste the text yourself.</p>
        {channel === "supplier_message" && <label>Who sent it? <span className="optional">(optional)</span><input value={sender} disabled={busy || !!savedId} maxLength={320} placeholder="Supplier name, email address, or phone number" onChange={event => setSender(event.target.value)}/></label>}
        <label>Message title <span className="optional">(optional)</span><input value={subject} disabled={busy || !!savedId} maxLength={500} onChange={event => setSubject(event.target.value)} placeholder="e.g. New delivery date for PO-1001"/></label>
        <label>When did the supplier send it? <span className="optional">(optional)</span><input type="datetime-local" value={sentAt} disabled={busy || !!savedId} onChange={event => setSentAt(event.target.value)}/></label>
        <p className="field-help">Add the sent date when the message says “tomorrow” or “next Friday”.</p>
      </div></details>
      <p className="field-help">Your message goes to the AI service to check for changes. You must approve any order update.</p>
      {savedId && error && <Notice>Your message is saved. Try checking it again, or open the saved message.</Notice>}{error && <Notice tone="error">{error}</Notice>}
      <div className="modal-actions">{savedId && error ? <button type="button" className="button button-secondary" onClick={() => onSaved(savedId)}>Open saved message</button> : <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>Cancel</button>}<div><button className="button button-primary" type="submit" value="analyze" disabled={busy || !text.trim()}><Icon name="check" size={16}/>{busy ? "Saving…" : "Check message"}</button><button className="button button-secondary" type="submit" value="save" disabled={busy || !text.trim()}>Save for later</button></div></div>
    </form>
  </Modal>;
}

/** A finished extraction is not always a proposed change. Show the actual next action. */
export function messageCheckLabel(message: SupplierMessage, proposals: ChangeProposal[], runs: Run[]): string {
  if (message.processingStatus === "RECEIVED") return "Not checked yet";
  if (message.processingStatus === "ANALYZING") return "Checking message";
  if (message.processingStatus === "FAILED") return "Could not finish";
  if (message.processingStatus === "REVIEW_REQUIRED") return "Needs your help";
  const proposal = proposals.find(item => item.messageId === message.id || item.analysisRunKey === message.proposalRunKey);
  if (proposal) return proposal.status === "PENDING" ? "Change ready to check" : readable(proposal.status);
  const run = runs.find(item => item.cacheKey === message.proposalRunKey);
  const commitment = run?.result?.commitment;
  const bothChanged = commitment && commitment.eta !== null && commitment.eta !== run?.request.context?.baselineEta && commitment.quantity !== null && commitment.quantity !== run?.request.context?.baselineQuantity;
  return run?.status === "needs_review" || bothChanged ? "Needs your help" : "Message checked";
}

export function Messages({ messages, orders, proposals, runs, revision, search, initialId, onCapture, onChanged, onReview }: { messages: SupplierMessage[]; orders: PO[]; proposals: ChangeProposal[]; runs: Run[]; revision: number; search: string; initialId: string | null; onCapture: () => void; onChanged: () => Promise<void>; onReview: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(initialId);
  const [filter, setFilter] = useState("all");
  useEffect(() => { if (initialId) setSelected(initialId); }, [initialId]);
  const filtered = messages.filter(message => `${message.subject ?? ""} ${message.sender ?? ""} ${message.text}`.toLowerCase().includes(search.toLowerCase()) && (filter === "all" || messageCheckLabel(message, proposals, runs) === filter)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return <><div className="page-note"><Icon name="inbox" size={18}/><span>Connected channels bring supplier messages here. You can also add a message yourself.</span></div><div className="split-workspace"><section className="panel message-list-panel"><PanelHeading title="Saved messages" subtitle={`${messages.length} saved ${messages.length === 1 ? "message" : "messages"}`} action={<button className="icon-button" aria-label="Add supplier message" onClick={onCapture}><Icon name="plus"/></button>}/><div className="list-filters"><select aria-label="Filter messages" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All messages</option><option value="Not checked yet">Not checked yet</option><option value="Needs your help">Needs your help</option><option value="Change ready to check">Change ready to check</option><option value="Could not finish">Could not finish</option><option value="Message checked">Message checked</option></select></div>{filtered.length ? <div className="message-list">{filtered.map(message => <button key={message.id} className={`message-item ${selected === message.id ? "selected" : ""}`} onClick={() => setSelected(message.id)}><div className="message-item-top"><span className="channel-label"><Icon name={message.channel === "supplier_email" ? "mail" : "inbox"} size={14}/>{channelLabel(message.channel)}</span><time>{dateLabel(message.receivedAt)}</time></div><strong>{message.subject || "Supplier update"}</strong><span className="message-sender">{message.sender ?? "Manually pasted message"}</span><p>{message.text}</p><Badge value={messageCheckLabel(message, proposals, runs) === "Needs your help" ? "REVIEW_REQUIRED" : message.processingStatus}>{messageCheckLabel(message, proposals, runs)}</Badge></button>)}</div> : <Empty title={messages.length ? "No matching messages" : "Bring your supplier updates together"}>{messages.length ? "Try another search or status filter." : "Connect Gmail from Connections to read supplier messages automatically. Or add a message yourself."}{!messages.length && <button className="button button-primary" onClick={onCapture}><Icon name="plus" size={16}/> Add message</button>}</Empty>}</section><section className="panel message-detail-panel">{selected ? <MessageDetail key={selected} id={selected} orders={orders} proposals={proposals} runs={runs} revision={revision} onChanged={onChanged} onReview={onReview}/> : <Empty icon="mail" title="Select a supplier message">Choose a message to read it and check for an order change.</Empty>}</section></div></>;
}

function MessageDetail({ id, orders, proposals, runs, revision, onChanged, onReview }: { id: string; orders: PO[]; proposals: ChangeProposal[]; runs: Run[]; revision: number; onChanged: () => Promise<void>; onReview: (id: string) => void }) {
  const { data, error, loading } = useResource<MessageDetailData>(`/messages/${encodeURIComponent(id)}`, revision);
  const [orderId, setOrderId] = useState(""); const [busy, setBusy] = useState(false); const [actionError, setActionError] = useState(""); const [notice, setNotice] = useState("");
  useEffect(() => { const selected = data?.candidates.find(candidate => candidate.isSelected); if (selected) setOrderId(selected.entityId); }, [data]);
  const process = async () => {
    setBusy(true); setActionError(""); setNotice("");
    try {
      if (orderId) await post(`/messages/${encodeURIComponent(id)}/link-purchase-order`, { entityId: orderId });
      await post(`/messages/${encodeURIComponent(id)}/queue`);
      setNotice("Your message is waiting to be checked. See progress in Email alerts. The order has not changed.");
      await onChanged();
    } catch (error) { setActionError(errorText(error)); }
    finally { setBusy(false); }
  };
  if (error) return <div className="panel-body"><Notice tone="error">{error}</Notice></div>;
  if (!data) return <div className="panel-body"><p className="loading-label">{loading ? "Loading message…" : "Message unavailable"}</p></div>;
  const proposal = proposals.find(proposal => proposal.messageId === id || proposal.analysisRunKey === data.message.proposalRunKey);
  const run = runs.find(item => item.cacheKey === data.message.proposalRunKey);
  const commitment = data.proposal?.commitment;
  const bothChanged = commitment && commitment.eta !== null && commitment.eta !== run?.request.context?.baselineEta && commitment.quantity !== null && commitment.quantity !== run?.request.context?.baselineQuantity;
  const processed = ["PROPOSAL_CREATED", "PROCESSED"].includes(data.message.processingStatus);
  const reason = data.proposal?.reason;
  const helpfulReason = reason?.startsWith("A newer supplier message") || reason?.startsWith("This email has unread attachments") ? reason : null;
  return <><div className="message-detail-head"><span className="eyebrow">ORIGINAL SUPPLIER MESSAGE</span><h2>{data.message.subject || "Supplier update"}</h2><div className="message-meta"><span><Icon name="mail" size={15}/>{data.message.sender ?? "Pasted note"}</span><span>{dateLabel(data.message.receivedAt, true)} · {channelLabel(data.message.channel)}</span>{data.message.sentAt && <span>Supplier sent: {new Date(data.message.sentAt).toLocaleString()}</span>}</div><Badge value={bothChanged ? "This message changes both the delivery date and quantity. This prototype cannot prepare both changes together. Update your order record outside the app." : messageCheckLabel(data.message, proposals, runs) === "Needs your help" ? "REVIEW_REQUIRED" : data.message.processingStatus}>{messageCheckLabel(data.message, proposals, runs)}</Badge></div><div className="message-body">{data.message.text}</div><div className="message-detail-actions">{proposal ? <><div className="proposal-summary"><span className="metric-icon orange"><Icon name="review"/></span><div><strong>{proposal.proposalType === "ETA_CHANGE" ? "New delivery date" : "New quantity"}</strong><p>{orderName(orders.find(po => po.entityId === proposal.entityId) ?? { entityId: proposal.entityId })} · {readable(proposal.status)}</p></div></div><button className="button button-primary" onClick={() => onReview(proposal.id)}>Check change<Icon name="arrow" size={16}/></button></> : processed ? <><Notice>{bothChanged ? "This message changes both the delivery date and quantity. This prototype cannot prepare both changes together. Update your order record outside the app." : messageCheckLabel(data.message, proposals, runs) === "Needs your help" ? helpfulReason ?? "We could not prepare this change. Read the message and ask the supplier to confirm the delivery date or quantity. Then add their reply as a new message." : "The message was checked. No delivery date or quantity change is ready to approve."}</Notice>{data.proposal && <RawDetails value={data.proposal} label="Technical details about this check"/>}</> : <><h3>Choose the order</h3><p className="muted">Choose an order if you know which one the supplier means.</p>{data.candidates.length > 0 && <div className="candidate-list">{data.candidates.map(candidate => <button className={`candidate ${orderId === candidate.entityId ? "selected" : ""}`} key={candidate.entityId} onClick={() => setOrderId(candidate.entityId)}><Icon name="box" size={16}/>{orderName(orders.find(po => po.entityId === candidate.entityId) ?? { entityId: candidate.entityId })}{candidate.isSelected && <small>Selected order</small>}</button>)}</div>}<label>Order<select value={orderId} disabled={busy} onChange={event => setOrderId(event.target.value)}><option value="">Find the order from the message</option>{orders.map(po => <option key={po.entityId} value={po.entityId}>{orderName(po)} · {po.supplierName}</option>)}</select></label><button className="button button-primary" disabled={busy} onClick={() => void process()}><Icon name="spark" size={16}/>{busy ? "Saving…" : "Check message"}</button><p className="field-help">We use AI to check this message. You must approve any order update.</p></>}{notice && <Notice>{notice}</Notice>}{actionError && <Notice tone="error">{actionError}</Notice>}</div></>;
}
