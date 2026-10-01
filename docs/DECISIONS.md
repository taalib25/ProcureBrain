# Architectural Decisions

## ADR-001: Event-sourced operational truth

Canonical events are immutable. Current PO state is a replay projection, not a mutable source-of-truth row.

## ADR-002: Deterministic operational decisions

Reducers, exception detection, priority ordering, idempotency, and entity resolution are deterministic TypeScript. AI can only produce validated proposals.

## ADR-003: pnpm workspace

The repository uses pnpm workspaces and pnpm scripts for all package management and verification commands.

## ADR-004: Cached ETL and model analysis

Analysis cache identity includes input bytes, media/analysis type, provider/model, prompt/schema versions, and any options affecting interpretation. Persist the source input and analysis attempt for replay. Durable PostgreSQL claim/lease with unique request key owns cross-process idempotency; an in-process promise map may optimize concurrent callers but is not the authority. Completed and reviewable results are cache hits; failed attempts are inspectable and retryable explicitly. Deterministic CSV ETL never requires model tokens. The API uses PaddleOCR first; supported images can use AI vision when local OCR fails. The standalone image helper offers a separate vision-first strategy and is not the API's runtime pipeline. Neither model nor OCR output writes operational events without validation/review.
