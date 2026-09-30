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

With `DATABASE_URL` set in the API process, startup connects through a PostgreSQL pool, applies the idempotent `migrations/0001_runtime.sql` bootstrap and `migrations/0002_analysis_cache_fencing.sql` fencing migration before serving requests, and uses PostgreSQL for source records, canonical events, PO references, and analysis cache/input retention. Configure `PG_POOL_MAX` to tune the pool (default `10`).

Without `DATABASE_URL`, the runtime deliberately uses process-local memory for local development and tests; it is neither durable nor suitable as production persistence. API uploads derive a stable source-record ID from source type and exact body bytes unless the caller supplies `idempotency-key` or `x-source-record-id`. Never commit `.env` files or real provider/database credentials; `.env.example` contains placeholders only.

The server applies both migrations at startup. Database operators may apply them manually with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/migrations/0001_runtime.sql` and `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f apps/api/migrations/0002_analysis_cache_fencing.sql` before launching the API. The fencing migration is equivalent to the DB package migration adding `owner_token` and `lease_generation`; it is idempotent. The API build copies both files beside the compiled runtime. Schema changes should be added as new ordered migrations and remain safe to reapply.

`/api/analysis/csv` performs deterministic, cacheable normalization and reports zero model tokens. Explicit `retry=true` reuses the original analysis cache identity and retries only when that exact request key currently has a failed run; completed/reviewable results remain cache hits.

`/api/analysis/supplier-text` accepts an optional `poContext` array of validated
purchase-order records (see `packages/ai/README.md` for the `PoContextRecord`
shape and the `pnpm --filter @procurebrain/ai build:context` builder). Pair a
supplier message with locally matched PO rows: the API rejects invalid context
with `400`, forwards valid records as delimited `<po_context>` factual context
while the original `text` remains the proposal `sourceText`, and includes the
context in the versioned cache identity (context and no-context requests cache
separately).

For the web review flow, the caller supplies the selected `entityId` when
requesting supplier-text analysis. The API snapshots that PO's public reference
and current ETA into the analysis run. The response includes the `cacheKey`.
After a person reviews and optionally edits the proposed ETA, the client posts
it to `/api/analysis/runs/:cacheKey/approve`. The API checks that the run is a
supplier-text proposal, the extracted PO reference matches the selected order,
the ETA is valid and different, and the PO ETA still matches the saved
baseline. If another update changed the order in the meantime, approval returns
`409` and asks the user to analyze again. Approval stores the original pasted
message as a source record and adds a `SUPPLIER_ETA_CHANGED` event (or
`SUPPLIER_ETA_CONFIRMED` when no prior ETA exists). The event time currently
uses analysis-run creation time because the form does not capture the supplier
message's original timestamp.

Only this explicit human approval path writes an event from a text proposal.
Document analysis still returns an inspection result and has no approval
endpoint flow. Email and messaging integrations are not implemented. Review
boundaries (`UNKNOWN_PO`, `AMBIGUOUS_PO`, `LOW_CONFIDENCE`, `DUPLICATE_SOURCE`)
remain visible to the reviewer; the person must inspect the source before
approving.
