# API runtime

`pnpm --filter @procurebrain/api dev` starts the HTTP API. Copy the workspace-root `.env.example` to `.env` and set `OPENROUTER_API_KEY` locally. At startup, the runtime searches the current working directory and up to four parent directories for `.env`, so it finds the workspace-root file when the filtered pnpm command runs from `apps/api`. Set `DOTENV_CONFIG_PATH` to use an explicit path instead.

The API process must receive the settings for provider requests to work. OpenRouter support is implemented in `packages/ai` and the API for supplier text, OCR text extraction, and image-vision fallback. Configure `AI_PROVIDER=openrouter`, `OPENROUTER_API_KEY`, and optionally `OPENROUTER_MODEL`; the default routed model is `~z-ai/glm-flash-latest`. OpenAI is supported as an opt-in compatibility provider with `AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optional `OPENAI_MODEL`.

`POST /api/analysis/document` (also available at the legacy `/api/analysis/image` path) accepts PNG, JPEG, WebP, and PDF bytes. It runs local PaddleOCR PP-StructureV3 first. Usable OCR text is sent to the configured extraction model; OCR page text, confidence, and layout blocks are retained as analysis evidence. If image OCR fails or returns no usable text, the configured vision model may be used as a fallback. PDF files never use vision: OCR failure remains a reviewable result. Without a configured text model, successful OCR can only use the conservative deterministic parser, and its output always requires review. No path inserts operational events automatically.

Install the local CPU OCR environment with Python 3.11:

```bash
uv venv --python 3.11 .venv-paddleocr
uv pip install --python .venv-paddleocr/bin/python "paddlepaddle==3.2.2" \
  --index-url https://www.paddlepaddle.org.cn/packages/stable/cpu/
uv pip install --python .venv-paddleocr/bin/python \
  -r apps/api/document-ocr/requirements.txt
PADDLEOCR_PYTHON=.venv-paddleocr/bin/python pnpm --filter @procurebrain/api dev
```

The first OCR request downloads PaddleX model weights. The long-lived worker loads them once and handles later requests locally. PaddlePaddle is pinned to 3.2.2 because 3.3+ has a reported CPU oneDNN/PIR inference failure in this pipeline. See `apps/api/document-ocr/README.md` for worker details. Provider tests use mocked fetch responses and do not require credentials; they verify request shape and response handling, not live service connectivity. A paid live OpenRouter request has not been verified as part of these tests.

With `DATABASE_URL` set in the API process, startup connects through a PostgreSQL pool and applies all ordered migrations (`0001_runtime.sql` through `0007_connector_state.sql`) before serving requests. PostgreSQL stores source records, canonical events, PO references, suppliers, messages, proposals, agent work, and connector checkpoints. Configure `PG_POOL_MAX` to tune the pool (default `10`).

Without `DATABASE_URL`, the runtime deliberately uses process-local memory for local development and tests; it is neither durable nor suitable as production persistence. API uploads derive a stable source-record ID from source type and exact body bytes unless the caller supplies `idempotency-key` or `x-source-record-id`. Never commit `.env` files or real provider/database credentials; `.env.example` contains placeholders only.

The API applies migrations at startup in order. If you manage migrations separately, apply every migration from `0001_runtime.sql` through `0007_connector_state.sql` in order before starting the API. Add schema changes as new ordered migrations and keep them safe to reapply.

Supplier messages are durable first-class entities: `POST /api/messages` ingests manually saved or connector-normalized messages, `POST /api/messages/:id/process` runs deterministic matching (exact PO reference, then sender-domain supplier narrowing, then open POs) and only calls the model for a single surviving candidate, and `POST /api/messages/:id/link-purchase-order` records a manual `USER_SELECTED` match. Tenancy resolves from `x-organization-id` (default `org-dev`); event streams stay organization-agnostic until full tenant boundaries land.

`/api/analysis/csv` performs deterministic, cacheable normalization and reports zero model tokens. Explicit `retry=true` reuses the original analysis cache identity and retries only when that exact request key currently has a failed run; completed/reviewable results remain cache hits.

`/api/analysis/supplier-text` accepts pasted supplier emails (subject + body in
`text`) with an optional selected `entityId` and an optional `poContext` array
of validated purchase-order records (see `packages/ai/README.md`). When a PO is
selected, the API always injects that PO's live operational baseline (reference,
current ETA, quantity, supplier, status) as the first `<po_context>` record, so
the model compares the message against current state without the client
supplying corpus rows. Extra caller `poContext` records are appended after it.
When no PO is selected, the API deterministically scans the message for
PO-prefixed references and returns `poCandidates` plus a `baseline` snapshot;
candidates are suggestions only and never auto-apply. Invalid context is
rejected with `400`, and context joins the versioned cache identity.

For the web review flow, paste the supplier email first: the API returns
`poCandidates` for one-click PO selection, then analyze again with the selected
`entityId` to get an ETA proposal grounded in that PO's current date. The API snapshots that PO's public reference
and current ETA plus event revision into the analysis run. The response includes the `cacheKey`.
After a person reviews and optionally edits the proposed ETA, the client posts
it to `/api/analysis/runs/:cacheKey/approve`. The API checks that the run is a
supplier-text proposal, the extracted PO reference matches the selected order,
the ETA is valid and different, and the PO event revision still matches the saved
baseline. Imports and approvals use the same per-PO PostgreSQL transaction locks. If another update changed the order in the meantime, approval returns
`409` and asks the user to analyze again. Approval stores the original pasted
message as a source record and adds a `SUPPLIER_ETA_CHANGED` event (or
`SUPPLIER_ETA_CONFIRMED` when no prior ETA exists). The event uses approval time, ordered after the current PO history when an imported event is future-dated. The form does not capture the supplier message's original timestamp. Retrying the same approval returns its saved event; a source ID reused with different text or source type returns `409`.

Only this explicit human approval path writes an event from a text proposal.
Uploaded invoice/image documents return an inspection result plus `poCandidates`;
`POST /api/analysis/runs/:cacheKey/bind` with an `entityId` deterministically
re-proposes the stored OCR commitment against that PO's live baseline (no new
model call) and returns a proposal that the same approval endpoint accepts.
The recorded source keeps its channel type (`supplier_image`/`supplier_pdf`).
Email and messaging integrations are not implemented. Review
boundaries (`UNKNOWN_PO`, `AMBIGUOUS_PO`, `LOW_CONFIDENCE`, `DUPLICATE_SOURCE`)
remain visible to the reviewer; the person must inspect the source before
approving.

Source taxonomy and per-channel provenance rules live in
`packages/ingestion/src/sources.ts` (`supplier_email`, `supplier_sms`,
`whatsapp`, document types, and the CSV set). Supplier-text requests accept an
optional channel `sourceType` with `provenance`; remote channels must supply
sender, channel message id, and received time. `normalizeWhatsAppPayload`
shows the adapter contract a future channel implements: native payload in,
claim text plus provenance out, then the shared pipeline.

## Purchasing agent runtime

The API now starts a background message worker. `POST /api/messages/:id/queue` (202) starts or retries a message job; `/process` also queues when called on a runtime with the agent enabled. `GET /api/agent` returns configuration status and the latest 200 work records. `POST /api/agent/emails/:id/retry` retries a failed email intent.

The worker supports one configured organization (`PROCUREBRAIN_AGENT_ORG`, default `org-dev`). Email is preview-only by default. PostgreSQL uses migration `0006_agent_runtime.sql`; memory storage resets on restart. See [agent architecture, setup and limitations](../../docs/AGENT_HARNESS.md). Current organization headers are not authenticated identities.

## Purchasing scenarios

`pnpm --filter @procurebrain/api evaluate:purchasing-agent` evaluates 34 authored cases against real HTTP/worker logic in fresh memory workspaces, using supplied extraction outputs. It does not connect to the running API or send emails. `--case=PC-01` selects one case. Explicit `--live-ai --limit=5` uses the configured model with preview-only notifications and may incur provider charges. See [the comprehensive guide](../../docs/PURCHASING_PRACTICE_GUIDE.md).


Gmail, WhatsApp Business text intake, supplier-history context, and the signed connector receiver are implemented but have not been connected to real accounts. Follow [the connector setup and limits](../../docs/CONNECTED_CHANNELS.md). Gmail requires a local Google OAuth setup; WhatsApp requires a business account and webhook configuration.
