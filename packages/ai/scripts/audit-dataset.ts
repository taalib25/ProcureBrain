import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditDataset } from "../src/audit.ts";
import { goldRequiresReview } from "../src/evaluate.ts";
import type { DatasetGold, DatasetMessage } from "../src/dataset.ts";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const parse = <T,>(contents: string): T[] => contents.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as T);
const messages = parse<DatasetMessage>(await readFile(resolve(root, "data/generated/supplier_messages.jsonl"), "utf8"));
const gold = parse<DatasetGold>(await readFile(resolve(root, "data/gold/expected_extractions.jsonl"), "utf8"));
const audit = auditDataset(messages, gold);
const directory = resolve(root, ".tmp/evaluations");
await mkdir(directory, { recursive: true });
const reportPath = resolve(directory, "dataset-audit.json");
const reviewPath = resolve(directory, "dataset-review.html");
await writeFile(reportPath, `${JSON.stringify(audit, null, 2)}\n`);
const byId = new Map(gold.map(row => [row.id, row]));
const escape = (value: unknown) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const rows = messages.map(message => {
  const label = byId.get(message.id);
  const issues = audit.issues.filter(issue => issue.id === message.id);
  return `<tr data-split="${escape(message.split)}"><td><strong>${escape(message.id)}</strong><br>${escape(message.split)}<br>${escape(message.templateFamily)}</td><td>${escape(message.message)}</td><td>${label ? `<strong>${goldRequiresReview(label) ? "Review required" : "Extraction expected"}</strong><pre>${escape(JSON.stringify(label.expected, null, 2))}</pre>` : "Missing label"}</td><td>${issues.map(issue => `<p>${escape(issue.message)}</p>`).join("") || "No known issue flagged; human review still needed."}</td></tr>`;
}).join("\n");
await writeFile(reviewPath, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>ProcureBrain benchmark review</title>
<style>body{font:16px/1.5 system-ui;margin:32px;color:#173e31;background:#f7faf7}h1{font-size:28px}p{max-width:85ch}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:16px;text-align:left;vertical-align:top;border:1px solid #ccd7cf}th{background:#e8f0eb}td:nth-child(2){width:30%}pre{white-space:pre-wrap;font-size:12px}input,select{font:inherit;padding:8px;margin-right:12px}tr[hidden]{display:none}</style>
<h1>ProcureBrain: inspect the synthetic benchmark</h1><p>These ${audit.messages} messages come from ${audit.patterns} authored patterns. The labels are generated expected answers, awaiting human review. They are used to evaluate extraction; the app does not train a model on them.</p>
<p>The historical holdout has already been examined. Keep its files unchanged and use a new unseen set for the next final accuracy claim. This page exposes it for transparency, not prompt tuning.</p>
<p>Within the 60-message holdout, 30 examples require review: 20 have no safe expected extraction and 10 inherit a review decision from a low confidence label. Confidence is not a human probability measurement.</p>
<p><strong>Known gaps:</strong> two pattern families conflict with the business-type definitions, and validation contains zero review cases. Reviewing this page does not automatically approve the labels.</p>
<label>Search <input id="search" placeholder="Message, PO, or pattern"></label><label>Split <select id="split"><option value="">All</option><option>development</option><option>validation</option><option>holdout</option></select></label><p id="count"></p>
<table><thead><tr><th>Example</th><th>Supplier message</th><th>Expected answer / label</th><th>Label notes</th></tr></thead><tbody>${rows}</tbody></table>
<script>const search=document.getElementById('search'),split=document.getElementById('split'),rows=[...document.querySelectorAll('tbody tr')];function filter(){let visible=0;for(const row of rows){row.hidden=(split.value&&row.dataset.split!==split.value)||!row.textContent.toLowerCase().includes(search.value.toLowerCase());if(!row.hidden)visible++}document.getElementById('count').textContent=visible+' examples shown'}search.addEventListener('input',filter);split.addEventListener('change',filter);filter();</script></html>`);
console.log(JSON.stringify({ messages: audit.messages, patterns: audit.patterns, structuralChecksPassed: audit.structuralChecksPassed, splits: audit.splits, errors: audit.issues.filter(issue => issue.severity === "error").length, warnings: audit.issues.filter(issue => issue.severity === "warning").length, reportPath, reviewPath }, null, 2));
if (!audit.structuralChecksPassed) process.exitCode = 1;
