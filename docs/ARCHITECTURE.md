# ProcureBrain Architecture

ProcureBrain is an event-sourced procurement operational-memory MVP. Immutable source records and canonical operational events are the source of truth. Pure domain reducers reconstruct purchase-order state; deterministic exception rules derive the attention queue. Hono, Drizzle, React, and AI adapters remain outside the domain package.

## Integration gates

1. Domain contracts and reducer
2. Persistence and ingestion
3. Exceptions and evaluations
4. API and UI
5. AI extraction proposals

## Analysis and idempotency

The analysis pipeline records source bytes/hash, normalized CSV or image request, model/provider configuration, prompt/schema versions, output, token usage, status, and fallback tier. All requests use one idempotency key derived from semantic input. An atomic claim guards concurrent calls across API instances. Deterministic event replay and exceptions remain outside model processing.

## Boundaries

- `packages/domain`: pure TypeScript operational truth.
- `packages/ingestion`: source normalization, entity resolution, idempotency.
- `packages/db`: PostgreSQL/Drizzle persistence.
- `packages/evals`: deterministic and end-to-end benchmarks.
- `packages/ai`: typed interpretation only; never writes canonical events directly.
- `packages/analysis-cache`: content/version-keyed replay cache for CSV, image, and model analysis runs.
- `apps/api`: thin HTTP adapters.
- `apps/web`: presentation and user actions.
