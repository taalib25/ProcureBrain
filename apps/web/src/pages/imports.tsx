import { useState, type ChangeEvent } from "react";
import { api, dateLabel, errorText, orderName, post, today } from "../api";
import { Empty, Icon, Notice, PanelHeading, RawDetails } from "../components/ui";
import type { Candidate, ChangeProposal, Commitment, PO, Run } from "../types";

function sampleCsv(kind: string) {
  const day = today(); const future = new Date(`${day}T00:00:00Z`); future.setUTCDate(future.getUTCDate() + 7);
  if (kind === "purchase-orders") return `po,event_type,occurred_at,quantity,supplier,eta\nPO-DEMO-1001,PO_CREATED,${day}T00:00:00Z,100,Example Supplier,${future.toISOString().slice(0, 10)}`;
  if (kind === "supplier-updates") return `po,event_type,occurred_at,eta\nPO-DEMO-1001,SUPPLIER_UPDATE,${day}T01:00:00Z,${future.toISOString().slice(0, 10)}`;
  if (kind === "receipts") return `po,event_type,occurred_at,quantity\nPO-DEMO-1001,RECEIPT,${day}T02:00:00Z,20`;
  return `po,event_type,occurred_at,message\nPO-DEMO-1001,FOLLOW_UP,${day}T03:00:00Z,Please confirm the revised delivery date`;
}
type ImportResult = { inserted?: number; events?: unknown[]; rejected?: unknown[]; unresolved?: unknown[] };
type DocumentResult = { run: Run; poCandidates?: Candidate[]; changeProposal?: ChangeProposal | null };

export function Imports({ orders, onChanged, onReview }: { orders: PO[]; onChanged: () => Promise<void>; onReview: (id: string) => void }) {
  const [mode, setMode] = useState("csv");
  return <><div className="import-mode-tabs"><button className={mode === "csv" ? "selected" : ""} aria-pressed={mode === "csv"} onClick={() => setMode("csv")}><Icon name="upload"/><span><strong>Add spreadsheet records</strong><small>Orders, delivery dates, goods received, and supplier replies</small></span></button><button className={mode === "document" ? "selected" : ""} aria-pressed={mode === "document"} onClick={() => setMode("document")}><Icon name="file"/><span><strong>Read a supplier document</strong><small>Read an image or PDF and choose its order</small></span></button></div>{mode === "csv" ? <CsvImport orders={orders} onChanged={onChanged}/> : <DocumentImport orders={orders} onChanged={onChanged} onReview={onReview}/>}</>;
}

function CsvImport({ orders, onChanged }: { orders: PO[]; onChanged: () => Promise<void> }) {
  const [kind, setKind] = useState("purchase-orders"); const [csv, setCsv] = useState(""); const [filename, setFilename] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [success, setSuccess] = useState(""); const [result, setResult] = useState<ImportResult | null>(null); const [preview, setPreview] = useState(false);
  const chooseFile = async (file?: File) => {
    if (!file) return;
    setError(""); setResult(null); setSuccess("");
    if (file.size > 5 * 1024 * 1024) { setError("Choose a CSV smaller than 5 MB."); return; }
    try { setCsv(await file.text()); setFilename(file.name); } catch (error) { setError(errorText(error)); }
  };
  const submit = async (isPreview: boolean) => {
    setBusy(true); setError(""); setSuccess(""); setResult(null); setPreview(isPreview);
    try {
      let response: ImportResult;
      if (isPreview) {
        const analysis = await post<{ run: { result: ImportResult } }>("/analysis/csv", { csv, purchaseOrders: orders.map(po => ({ entityId: po.entityId, poNumber: orderName(po) })) });
        response = analysis.run.result;
      } else response = await api<ImportResult>(`/imports/${kind}`, { method: "POST", headers: { "content-type": "text/csv" }, body: csv });
      setResult(response); setSuccess(isPreview ? "File checked. No orders have changed." : `Added ${response.inserted ?? 0} new ${(response.inserted ?? 0) === 1 ? "record" : "records"}. Your orders are updated.`);
      await onChanged();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  return <div className="import-layout"><section className="panel"><PanelHeading title="Add spreadsheet records" subtitle="Upload a CSV file saved from your spreadsheet"/><div className="panel-body form-stack"><label>Record type<select value={kind} disabled={busy} onChange={event => { setKind(event.target.value); setResult(null); setSuccess(""); }}><option value="purchase-orders">Purchase orders</option><option value="supplier-updates">Delivery date updates</option><option value="receipts">Goods received</option><option value="followups">Supplier follow-ups</option></select></label><label className="upload-zone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) void chooseFile(event.dataTransfer.files[0]); }}><span className="upload-icon"><Icon name="upload" size={26}/></span><strong>{filename || "Choose a CSV or drop it here"}</strong><span>CSV files up to 5 MB. You can also paste the contents below.</span><input type="file" accept=".csv,text/csv" disabled={busy} onChange={event => void chooseFile(event.target.files?.[0])}/></label><details className="optional-details"><summary>Paste or edit spreadsheet text</summary><div className="field-heading"><label htmlFor="csv-content">CSV content</label><button className="text-button" disabled={busy} onClick={() => { setCsv(sampleCsv(kind)); setFilename("Example CSV"); setResult(null); setSuccess(""); }}>Use example<Icon name="arrow" size={13}/></button></div><textarea id="csv-content" className="code-input" aria-label="CSV content" rows={8} value={csv} disabled={busy} onChange={event => { setCsv(event.target.value); setResult(null); setSuccess(""); }} placeholder="po,event_type,occurred_at,quantity,supplier,eta"/></details><p className="field-help">Save your spreadsheet as a CSV file before uploading it. Check the file before adding records.</p><div className="actions"><button className="button button-primary" disabled={busy || !csv.trim()} onClick={() => void submit(true)}>{busy && preview ? "Checking…" : "Check file"}</button><button className="button button-secondary" disabled={busy || !csv.trim() || !result || !preview} onClick={() => void submit(false)}><Icon name="upload" size={16}/>{busy && !preview ? "Adding…" : "Add to orders"}</button></div>{error && <Notice tone="error">{error}</Notice>}{success && <Notice tone="success">{success}</Notice>}{result && <><div className="import-results"><div><strong>{preview ? result.events?.length ?? 0 : result.inserted ?? 0}</strong><span>{preview ? "Records found" : "Records added"}</span></div><div><strong>{result.rejected?.length ?? 0}</strong><span>Rows to fix</span></div><div><strong>{result.unresolved?.length ?? 0}</strong><span>Orders not found</span></div></div>{!!result.rejected?.length && <RawDetails value={result.rejected} label="See rows to fix"/>}{!!result.unresolved?.length && <RawDetails value={result.unresolved} label="See orders not found"/>}</>}</div></section><aside className="panel import-guide"><span className="guide-illustration"><Icon name="box" size={36}/></span><h2>A good starting point</h2><p>Import the original purchase order before recording supplier updates or receipts.</p><ol className="numbered-guide"><li><strong>Include the order number</strong><span>It connects activity to the correct order.</span></li><li><strong>Use clear dates and quantities</strong><span>Dates use YYYY-MM-DD. For a record time, use a value such as 2026-10-06T09:00:00Z.</span></li><li><strong>See rows to fix</strong><span>Fix rows with missing or incorrect details, then check the file again.</span></li></ol><div className="guide-footnote"><Icon name="shield" size={18}/><span>Adding spreadsheet records updates orders immediately. Supplier messages and documents need a separate approval.</span></div></aside></div>;
}

function DocumentImport({ orders, onChanged, onReview }: { orders: PO[]; onChanged: () => Promise<void>; onReview: (id: string) => void }) {
  const [file, setFile] = useState<File | null>(null); const [result, setResult] = useState<DocumentResult | null>(null); const [orderId, setOrderId] = useState(""); const [busy, setBusy] = useState(false); const [binding, setBinding] = useState(false); const [error, setError] = useState("");
  const choose = (file?: File) => { setError(""); setResult(null); if (file && file.size > 5 * 1024 * 1024) { setError("Choose a document smaller than 5 MB."); return; } setFile(file ?? null); };
  const analyze = async () => {
    if (!file) return;
    setBusy(true); setError(""); setResult(null);
    try {
      const mime = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
      const response = await api<DocumentResult>("/analysis/document", { method: "POST", headers: { "content-type": mime }, body: file });
      setResult(response); setOrderId(response.poCandidates?.length === 1 ? response.poCandidates[0].entityId : ""); await onChanged();
    } catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const bind = async () => {
    if (!result?.run.cacheKey || !orderId) return;
    setBinding(true); setError("");
    try {
      const bound = await post<{ changeProposal?: ChangeProposal | null }>(`/analysis/runs/${encodeURIComponent(result.run.cacheKey)}/bind`, { entityId: orderId });
      await onChanged();
      if (bound.changeProposal) onReview(bound.changeProposal.id);
      else setError("The document was linked, but no date or quantity change could be prepared for approval.");
    } catch (error) { setError(errorText(error)); }
    finally { setBinding(false); }
  };
  const commitment: Commitment | null = result?.run.result?.commitment ?? null;
  return <div className="import-layout"><section className="panel"><PanelHeading title="Read a supplier document" subtitle="Read the result, choose the order, and check the change"/><div className="panel-body form-stack"><label className="upload-zone" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); if (!busy) choose(event.dataTransfer.files[0]); }}><span className="upload-icon"><Icon name="file" size={26}/></span><strong>{file ? file.name : "Choose an image or PDF"}</strong><span>{file ? `${(file.size / 1024).toFixed(0)} KB · Ready to check` : "PDF, PNG, JPEG, or WebP · Up to 5 MB"}</span><input type="file" accept="image/png,image/jpeg,image/webp,application/pdf,.pdf" disabled={busy} onChange={(event: ChangeEvent<HTMLInputElement>) => choose(event.target.files?.[0])}/></label><button className="button button-primary" disabled={!file || busy} onClick={() => void analyze()}><Icon name="spark" size={16}/>{busy ? "Reading document…" : "Check document"}</button><p className="field-help">We send this file to a text-reading service and AI service. Check the result before choosing its order.</p>{error && <Notice tone="error">{error}</Notice>}{commitment ? <section className="document-extract"><span className="eyebrow">EXTRACTED INFORMATION</span><div className="facts"><div><small>Order number</small><strong>{commitment.poReference ?? "Not found"}</strong></div><div><small>Delivery date</small><strong>{dateLabel(commitment.eta, true)}</strong></div><div><small>Quantity</small><strong>{commitment.quantity ?? "Not found"}</strong></div></div><label>Which order is this for?<select value={orderId} disabled={binding} onChange={event => setOrderId(event.target.value)}><option value="">Choose the matching order</option>{orders.map(po => <option key={po.entityId} value={po.entityId}>{orderName(po)} · {po.supplierName}</option>)}</select></label>{!!result?.poCandidates?.length && <p className="field-help">Suggested: {result.poCandidates.map(candidate => candidate.poNumber ?? candidate.entityId).join(", ")}</p>}<button className="button button-primary" disabled={!orderId || binding} onClick={() => void bind()}>{binding ? "Preparing review…" : "Prepare change"}<Icon name="arrow" size={16}/></button><p className="field-help">The order stays the same. Go to Check changes to approve the update.</p></section> : result && <Notice>{result.run.result?.reason ?? "No usable supplier update was extracted. Inspect the document and analysis details."}</Notice>}{result && <RawDetails value={result} label="Technical details about this document"/>}</div></section><aside className="panel import-guide"><span className="guide-illustration"><Icon name="file" size={36}/></span><h2>Check the supplier document</h2><p>A document can contain several dates. Check that the suggested date is when the supplier will deliver.</p><ol className="numbered-guide"><li><strong>Read the document</strong><span>We read the text in your file.</span></li><li><strong>Match the correct order</strong><span>Check the Order number and supplier.</span></li><li><strong>Review before approving</strong><span>Compare the suggested date or quantity with the order.</span></li></ol></aside></div>;
}
