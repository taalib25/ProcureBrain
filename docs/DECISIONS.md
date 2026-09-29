# Architectural Decisions

## ADR-001: Event-sourced operational truth

Canonical events are immutable. Current PO state is a replay projection, not a mutable source-of-truth row.

## ADR-002: Deterministic operational decisions

Reducers, exception detection, priority ordering, idempotency, and entity resolution are deterministic TypeScript. AI can only produce validated proposals.

## ADR-003: pnpm workspace

The repository uses pnpm workspaces and pnpm scripts for all package management and verification commands.

## ADR-004: Cached ETL and model analysis

Analysis cache identity includes input bytes, media/analysis type, provider/model, prompt/schema versions, and any options affecting interpretation. Persist the source input and analysis attempt for replay. Durable PostgreSQL claim/lease with unique request key owns cross-process idempotency; an in-process promise map may optimize concurrent callers but is not the authority. Completed and reviewable results are cache hits; failed attempts are inspectable and retryable explicitly. Deterministic CSV ETL never requires model tokens. Vision is the first image interpretation tier; OCR is invoked only as a fallback on provider failure, invalid output, or insufficient confidence. Neither model nor OCR output writes operational events without validation/review.
