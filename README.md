# ProcureBrain

**Status: under active development.** A small-business owner who handles purchasing needs a quick answer to a simple question: **which order changed or needs attention, and what evidence explains why?** ProcureBrain is a prototype that turns imported purchase-order activity into a timeline and an attention queue, so the owner can spot late orders and quantity mismatches.

The current workflow starts with CSV imports. For pasted supplier text, the app can draft an ETA change, show it beside the PO's current date and source message, and record it after a person approves it. Document uploads still return analysis for inspection, and there is no inbox connection. The project is not production-ready, and AI extraction has only been measured on a small synthetic benchmark, not a representative set of real supplier messages. Treat model output as a proposal until a person reviews it.

For the plain-language problem, solution, and a short demo script, see [the product story](docs/PRODUCT_STORY.md).

See [what is implemented and what to do next](docs/PROJECT_STATUS.md) for the project roadmap.

## What it does today

- Imports purchase orders, supplier ETA updates, receipts, and follow-ups from CSV.
- Stores operational changes as immutable events and rebuilds current purchase-order state by replaying them.
- Detects exceptions such as overdue orders and quantity mismatches, with evidence attached to each result.
- Analyzes pasted supplier text and uploaded images or PDFs. A pasted-text ETA proposal can be edited and approved into a PO event; document analysis is still inspection-only.
- Caches analysis runs and can persist source records, events, and cache data in PostgreSQL.

CSV normalization and exception detection are deterministic and do not use model tokens. Model analysis only creates a proposal; an approved proposal becomes an operational event after a person confirms it.

## Architecture

```text
CSV import → source evidence + canonical events → PO timeline and current state
                                             ↓
                                  exception / attention queue

Pasted supplier text → AI proposal → human edits/approves → PO event → timeline/queue
Document upload → OCR and AI analysis → inspect result (approval flow not connected yet)
```

The workspace is organized as a pnpm monorepo:

- `apps/api` — Hono API, runtime, and document OCR worker integration.
- `apps/web` — React/Vite review interface.
- `packages/domain` — event contracts, purchase-order reducer, and exception logic.
- `packages/ingestion` — CSV normalization, entity resolution, and idempotency.
- `packages/db` — Drizzle schema and PostgreSQL repository.
- `packages/analysis-cache` — versioned, content-keyed analysis cache.
- `packages/ai` — validated extraction proposals, provider adapters, and local context/evaluation utilities. The API records an ETA event only after explicit human approval.
- `packages/evals` — deterministic exception scenarios and integration coverage.

## Technology

TypeScript, React, Vite, Hono, PostgreSQL, Drizzle ORM, Vitest, PaddleOCR, and OpenRouter. OpenAI-compatible extraction is also available as an optional provider.

## Run locally

Requirements: Node.js, pnpm 9, and (optionally) PostgreSQL. Install dependencies and create a local environment file:

```bash
pnpm install
cp .env.example .env
```

Add an OpenRouter API key to `.env` to enable hosted model extraction. Start the API:

```bash
pnpm --filter @procurebrain/api dev
```

In another terminal, start the web app:

```bash
pnpm --filter @procurebrain/web dev
```

Open <http://localhost:5173>. The web development server forwards `/api` requests to the API on port `8787`.

For durable storage, set `DATABASE_URL` in the API environment. Without it, the API uses process-local memory, which is intended for local development only. See [apps/api/README.md](apps/api/README.md) for PostgreSQL and OCR setup details.

## Development commands

```bash
pnpm typecheck
pnpm test
pnpm build
```

Provider tests use mocked responses and do not require API credentials.

To run the synthetic supplier-message benchmark against the configured live
provider, use `pnpm --filter @procurebrain/api evaluate:supplier-extraction -- --split=holdout`.
This sends one provider request per example in the selected split and may incur
API charges. Predictions and a metadata report are saved under `.tmp/`.

## Current validation and known gaps

- The last recorded project verification (September 25, 2026) reports 75 passing Vitest tests, with typecheck and build passing. PostgreSQL persistence and duplicate-request concurrency were also checked at that time.
- A September 30, 2026 OpenRouter holdout run exactly matched 27/60 complete synthetic examples (45%). Field matches were 92.5% for PO reference, 97.5% for ETA, 92.5% for quantity, and 47.5% for business type. It sent only 13/30 gold review-required cases to review. These are synthetic-label match rates; two scenario families have type labels that conflict with the prompt taxonomy. See the [full evaluation notes](docs/evaluations/2026-09-30-holdout.md).
- A three-document OCR smoke check reported a mean reference-word recall proxy of 0.9737. This is a small text-overlap check, not a general OCR score or supplier-extraction accuracy measurement.
- The OCR-to-PO context matching and as-of-message-time context flow is documented as future work.

The project is being built iteratively. Gold-label review, evaluation on representative supplier messages, safer review routing, and the remaining OCR context flow are areas for continued development.

## Local datasets and credentials

Local archives, extracted data, and processed PO context are kept under `data/datasets/` and excluded from Git. Dataset reuse may require attribution or license review; see [packages/ai/README.md](packages/ai/README.md). Do not add private company documents or supplier data to this public repository.

Copy `.env.example` for local configuration. Never commit `.env`, API keys, database credentials, or other secrets.

## Project documents

- [Product story and demo script](docs/PRODUCT_STORY.md)
- [Dataset and code walkthrough](docs/PROJECT_WALKTHROUGH.md)
- [First supplier extraction evaluation](docs/evaluations/2026-09-30-holdout.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Event contract](docs/EVENT_CONTRACT.md)
- [Design decisions](docs/DECISIONS.md)
- [AI extraction and dataset notes](packages/ai/README.md)
- [API setup](apps/api/README.md)

## License

No license has been added yet. Until a license is chosen, all rights are reserved by the author.
