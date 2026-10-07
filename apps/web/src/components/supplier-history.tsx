import { useState } from "react";
import { channelLabel, dateLabel, readable, useResource } from "../api";
import { Empty, Icon, Notice, RawDetails } from "./ui";

type HistoryItem = { id: string; kind: string; occurredAt: string; receivedAt?: string; title: string; text?: string; channel?: string; sourceRecordId: string; threadId?: string; orderId?: string; payload?: { eta?: string; quantity?: number } };
type History = { summary: { savedMessages: number; openOrders: number; pendingChanges: number; lastMessageAt: string | null; channels: string[] }; timeline: HistoryItem[]; truncated: boolean };
export function SupplierHistory({ supplierId }: { supplierId: string }) {
  const { data, error, loading } = useResource<History>(`/suppliers/${encodeURIComponent(supplierId)}/history`);
  const [limit, setLimit] = useState(10);
  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) return loading ? <p className="loading-label">Loading supplier history…</p> : null;
  return <section className="supplier-memory"><h3 className="section-label">Supplier history</h3><p>{data.summary.savedMessages} saved messages · {data.summary.openOrders} open orders · {data.summary.pendingChanges} changes to check</p><p className="field-help">{data.summary.channels.length ? `Messages from ${data.summary.channels.map(channelLabel).join(", ")}.` : "Saved supplier messages will appear here beside order updates."} Dates show when a message was sent or an order event happened.</p>
    {data.timeline.length ? <><ol className="timeline">{data.timeline.slice(0, limit).map(item => <li key={`${item.kind}/${item.id}`}><span className="timeline-node"><Icon name={item.kind === "message" ? "mail" : "box"} size={15}/></span><div><strong>{item.kind === "message" ? item.title : readable(item.title)}</strong><span>{item.channel ? channelLabel(item.channel) : "Order update"}{item.payload?.eta ? ` · Delivery date: ${dateLabel(item.payload.eta, true)}` : item.payload?.quantity !== undefined ? ` · ${item.payload.quantity} units` : ""}</span>{item.text && <details className="optional-details"><summary>Read message</summary><blockquote className="source-quote">{item.text}</blockquote></details>}<RawDetails value={item} label="Source details"/></div><time>{dateLabel(item.occurredAt, true)}</time></li>)}</ol>{limit < data.timeline.length && <button className="button button-secondary" onClick={() => setLimit(value => value + 15)}>Show older history</button>}{data.truncated && <p className="field-help">The latest 200 records are shown.</p>}</> : <Empty title="No saved history yet">Connect a channel or add a supplier message to start the history.</Empty>}
  </section>;
}
