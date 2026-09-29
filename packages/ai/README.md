# AI extraction and PO context

`packages/ai` holds the typed supplier-text extraction boundary. Model output is
proposal-only: every result is Zod-validated into an `EventProposal` with a
review state and never creates or persists an operational event.

## Local PO-context corpus

`src/context.ts` defines the canonical `PoContextRecord`: one stable JSON shape
covering both structured purchase-order datasets without cross-joining them.

- `supply-chain` records map `procurement_orders.csv` rows and left-join only
  their own `supplier_master.csv` / `product_master.csv` lookups.
- `procurement-kpi` records map `Procurement KPI Analysis Dataset.csv` rows
  standalone (supplier name, category, status, negotiated price, defective
  units, compliance).
- Missing values become `null`; no emails are generated and no labels invented.
- Every record carries `provenance: { sourceDataset, sourceFile }`.

The unrelated `company-document-text.csv` corpus (Northwind-derived document
text, `text,label,word_count`) is never joined into PO context: its POs do not
correspond to either structured dataset.

## Building the corpus

Raw archives live under `data/datasets/raw/` and extracted CSVs under
`data/datasets/extracted/`. Both stay local: `data/datasets/` is git-ignored,
so never commit raw archives, extracted rows, or processed records.

```bash
# After placing the Kaggle zips in data/datasets/raw/ and extracting them to
# data/datasets/extracted/<supply-chain|procurement-kpi|company-documents>/:
pnpm --filter @procurebrain/ai build:context
# Writes data/datasets/processed/po-context.jsonl (one record per line).
```

CLI overrides (all optional; defaults are the paths above):

```bash
pnpm --filter @procurebrain/ai build:context -- \
  --supply-orders=<path> --supplier-master=<path> --product-master=<path> \
  --kpi=<path> --out=<path>
```

The builder validates required headers, reports missing input files by path
without printing source rows, and prints only record counts and the output
path. Current local run: 2,777 records (2,000 supply-chain, 777
procurement-kpi).

## Pairing an email with PO context

1. Match the supplier message to PO rows locally (e.g. PO reference lookup in
   `data/datasets/processed/po-context.jsonl`).
2. Send the matched records as `poContext` alongside `text` to
   `POST /api/analysis/supplier-text`.
3. The API validates `poContext` against `PoContextRecordSchema` (invalid
   context is rejected with `400`), forwards it as delimited `<po_context>`
   factual context while the original message stays the proposal `sourceText`,
   and includes it in the versioned cache identity.

Prompt taxonomy: `new_commitment` for a newly stated future commitment;
`eta_change` / `quantity_change` only when the message explicitly revises or
compares against a prior ETA/quantity (PO context is the baseline);
`general_update` for other status. Supplier text is treated as untrusted
evidence, never instructions.

## Provenance and licensing

- Supply-chain dataset: CC BY 4.0 (attribute the source when reusing).
- Procurement-KPI dataset: CC0.
- Company-document dataset: different Northwind provenance; check its Kaggle
  license before any reuse. It is unrelated OCR/text data, not PO ground
  truth.

Automated provider tests use mocked fetch responses and do not require
credentials; they verify request shape and response handling, not live service
connectivity. Separate live smoke requests have verified text and image
responses, but not accuracy on a labeled dataset. The initial synthetic smoke
examples extracted PO/date/quantity but returned inconsistent commitment-type
labels; use a labeled dataset to evaluate and tune this behavior.

## Document OCR and future context builder

The API processes images and PDFs with local PaddleOCR PP-StructureV3 before
calling a language model. Successful OCR text is passed to the configured text
extractor; GLM/OpenAI vision fallback is allowed only when image OCR fails.
PDFs have no vision fallback. OCR pages preserve page index, confidence,
recognized text, and available layout block coordinates. OCR output is source
evidence, not an operational event.

Run a bounded local OCR check when the Northwind-derived CompanyDocuments
archive and its supplied extracted-text CSV are present under `data/datasets/`:

```bash
.venv-paddleocr/bin/python packages/ai/scripts/evaluate-document-ocr.py --sample-size 5
```

The report measures OCR text availability, order ID/date/customer-name recovery,
and a word-overlap proxy against the dataset-provided extracted text. That CSV
is not independent structured PO ground truth; this check does not estimate
supplier-message extraction accuracy. It reports PDF review routing for OCR
failures and records that image fallback is not part of this PDF-only sample.
The local three-PDF smoke sample recovered order ID, date, and customer name in
3/3 documents, with a mean reference-word recall proxy of 0.9737. This small
sanity check is not a general accuracy guarantee.

The later OCR context builder should sit between OCR and text extraction and:

1. Resolve exact or normalized PO numbers and known aliases against the PO
   reference index; preserve unknown and ambiguous outcomes for review.
2. Load supplier and product relationships only through the matched PO's own
   links. Do not join unrelated company-document OCR text into canonical PO
   context.
3. Replay operational events only through the supplier message's timestamp to
   derive the as-of-message PO baseline; later events must not leak into the
   comparison context.
4. Keep PO-document facts distinct from supplier-message claims and attach
   provenance to each OCR fact (source document, page, block/coordinates,
   confidence, and extraction time).
5. Pass validated PO context separately from OCR source evidence; keep the
   source text as the proposal evidence and keep model output proposal-only.
