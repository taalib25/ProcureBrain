# ProcureBrain review against claude.dev guidance

Reviewed on October 1, 2026. This records concrete code changes and evaluation limitations; it does not certify production readiness.

## Reference and application

Anthropic's [evaluation design guidance](https://claude.dev/blog/automating-eval-design-and-hillclimbing/) recommends cases that reflect actual use, checking expected answers and graders, separating infrastructure failures from model behavior, and keeping final evaluation examples separate from tuning. These principles apply to ProcureBrain even though its current extraction provider is OpenRouter.

| Principle | Finding in ProcureBrain | Action |
| --- | --- | --- |
| Cases reflect the intended use | 300 synthetic messages cover 30 authored patterns; they are broader than the first ETA-change use case | Keep the benchmark as a controlled check; collect representative supplier messages for business-use accuracy |
| Check expected answers | Two pattern families have business-type labels that conflict with the prompt definitions | Flag all 20 examples in the audit; preserve the historical benchmark files |
| Review decisions have clear labels | Ten holdout examples inherit their expected review decision from an authored confidence score | Support explicit `reviewRequired` labels for the next benchmark; retain legacy scoring compatibility |
| Test review routing | Validation has zero review-required examples | Expose this coverage gap; construct a new validation set with clear, ambiguous, conflicting, and unsupported updates |
| Distinguish failed runs | A failed extraction could count as successful abstention on an ambiguous example | Future runs mark adapter failures; scoring reports failures, malformed outputs, missing predictions, missed reviews, and unnecessary reviews separately |
| Protect the final evaluation | The September 30 holdout has already been examined | Default live evaluation to development; use a new unseen set before a new final accuracy claim |

## Operational fixes

- Imports and approvals use the same PostgreSQL transaction locks for each PO. Approval reads and compares its saved event revision while holding that lock.
- Every new PO event invalidates an older draft, including a later confirmation of the same ETA.
- Repeated approval requests return the existing event. Approval timestamps place the approved update after the current PO history, including future-dated imports. The supplier's original send time is still not collected.
- Source IDs are immutable: different content or source types return HTTP 409 instead of linking a new update to old evidence.
- Request schemas reject malformed JSON before store or provider calls. Extraction validation rejects impossible calendar dates.
- The selected timeline and source list refresh after changes. Slow requests for a previous selection cannot replace the current timeline.
- PostgreSQL analysis history uses the same field names as the browser and memory-mode API.

## Inspect the samples yourself

```bash
pnpm --filter @procurebrain/ai audit:dataset
```

Open `.tmp/evaluations/dataset-review.html`. It shows every synthetic message, its expected extraction, the expected review decision, and known label issues. Filter by split or search by message/PO/pattern. The page uses no external services and makes no model calls. `.tmp/evaluations/dataset-audit.json` contains the machine-readable report.

The current audit reports 300 messages and labels, 30 patterns, zero structural errors, and 31 warnings: 20 business-type label warnings, 10 confidence-derived review labels, and one validation coverage warning. Thirty review-required **holdout examples** and thirty total **message patterns** are different counts.

## Verification and remaining work

The review added meaningful regression tests for concurrent and stale approvals, idempotent retry, immutable evidence, request validation, impossible dates, dataset structure, and scoring failures. Real PostgreSQL tests create a unique temporary schema when `PROCUREBRAIN_TEST_DATABASE_URL` is set; they do not clear existing tables.

Verification on October 1: all 102 tests passed, including three tests against an isolated PostgreSQL 16 database. `pnpm typecheck`, `pnpm build`, and `git diff --check` passed. Browser checks confirmed CSV import, refresh of the selected PO's ETA and timeline, source-list refresh while the import screen remained open, and filtering the 300-example review page. Supplier extraction in regression tests used controlled adapters; no live model run was performed.

Live model accuracy was not re-evaluated during this review. The September 30 result remains a historical synthetic-label match rate. Labels still need human review, and representative supplier messages are still needed. Authentication and business-specific data isolation, automatic inbox capture, document approval, and the supplier-message timestamp flow remain unfinished.
