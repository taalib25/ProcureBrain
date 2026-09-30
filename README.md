# ProcureBrain

**Status: under active development.** ProcureBrain is a procurement operations prototype that turns purchase order activity into a replayable timeline, highlights deterministic exceptions, and helps teams review supplier updates with their supporting evidence.

The core workflow is implemented, but the project is not production-ready. In particular, AI supplier-message extraction has not been measured against a labeled evaluation set. Treat model output as a review proposal, not as a verified operational fact.

## What it does

- Imports purchase orders, supplier updates, receipts, and follow-ups from CSV.
- Stores operational changes as immutable events and rebuilds current purchase-order state by replaying them.
- Detects exceptions such as overdue orders and quantity mismatches, with evidence attached to each result.
- Analyzes supplier text and uploaded images or PDFs. Local PaddleOCR runs first for documents; a configured language model can turn extracted text into a typed proposal for human review.
- Caches analysis runs and can persist source records, events, and cache data in PostgreSQL.

AI analysis is deliberately proposal-only: it does not create or change operational events. CSV normalization and exception detection are deterministic and do not use model tokens.

## Architecture

```text
CSV / supplier message / document
                ↓
       source evidence record
                ↓
  canonical events (human approved)
                ↓
     pure purchase-order reducer
                ↓
      exception and attention queue
```

The workspace is organized as a pnpm monorepo:

- `apps/api` — Hono API, runtime, and document OCR worker integration.
- `apps/web` — React/Vite review interface.
- `packages/domain` — event contracts, purchase-order reducer, and exception logic.
- `packages/ingestion` — CSV normalization, entity resolution, and idempotency.
- `packages/db` — Drizzle schema and PostgreSQL repository.
- `packages/analysis-cache` — versioned, content-keyed analysis cache.
- `packages/ai` — validated extraction proposals, provider adapters, and local context/evaluation utilities.
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

## Current validation and known gaps

- The last recorded project verification (September 25, 2026) reports 75 passing Vitest tests, with typecheck and build passing. PostgreSQL persistence and duplicate-request concurrency were also checked at that time.
- Live model smoke requests returned structured text and image responses, but supplier-message extraction accuracy has **not** been measured on a labeled dataset. Small synthetic examples returned inconsistent commitment-type labels.
- A three-document OCR smoke check reported a mean reference-word recall proxy of 0.9737. This is a small text-overlap check, not a general OCR score or supplier-extraction accuracy measurement.
- The OCR-to-PO context matching and as-of-message-time context flow is documented as future work.

The project is being built iteratively. Evaluation on labeled supplier messages, extraction tuning, and the remaining OCR context flow are areas for continued development.

## Local datasets and credentials

Local archives, extracted data, and processed PO context are kept under `data/datasets/` and excluded from Git. Dataset reuse may require attribution or license review; see [packages/ai/README.md](packages/ai/README.md). Do not add private company documents or supplier data to this public repository.

Copy `.env.example` for local configuration. Never commit `.env`, API keys, database credentials, or other secrets.

## Project documents

- [Dataset and code walkthrough](docs/PROJECT_WALKTHROUGH.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Event contract](docs/EVENT_CONTRACT.md)
- [Design decisions](docs/DECISIONS.md)
- [AI extraction and dataset notes](packages/ai/README.md)
- [API setup](apps/api/README.md)

## License

No license has been added yet. Until a license is chosen, all rights are reserved by the author.
