# Purchasing agent practice evaluation — October 6, 2026

## What was evaluated

The `purchasing-practice-v1` pack has **34 authored message scenarios** and **seven order baselines** drawn from local supply-chain and procurement-KPI records. Future dates, contact addresses and supplier messages are authored. The existing synthetic holdout and realistic final split were not modified or evaluated.

The runner creates a fresh isolated memory workspace for every case and uses the actual capture, matching, background job, analysis/proposal and email outbox code. Its extraction adapter returns the supplied fixture. **This measures workflow behavior given that output, not the model's ability to understand a message.**

## Results

| Check | Result |
| --- | ---: |
| Offline business scenarios | 34 / 34 passed |
| New purchasing regression tests, including those 34 scenarios | 59 passed |
| Complete API test suite | 110 passed; 7 PostgreSQL tests skipped |
| Complete workspace test suite | 193 passed; 7 PostgreSQL tests skipped |
| API typecheck and web production build | Passed |
| Live model requests during this iteration | 0 |
| Real emails sent during this iteration | 0 |

The 59 new tests overlap with the scenario runner's 34 cases; they are not 93 independent message examples. The seven skipped checks comprise three existing approval tests and four new queue tests. No test PostgreSQL connection was configured.

### Scenario coverage

| Category | Passed / cases |
| --- | ---: |
| Everyday purchasing | 9 / 9 |
| Order matching | 6 / 6 |
| Unclear commitments | 11 / 11 |
| Meaning and noise | 4 / 4 |
| Provider boundaries | 4 / 4 |

## Bugs revealed and corrected

The first offline run of the initial **32-case** pack passed 15 cases. Seventeen failed expectations exposed missing routing and notification behavior. Two additional cases subsequently covered KPI quantity shortfalls and partial shipment semantics.

The changes now:

- prevent explicit unknown/confusable PO references from falling back to a different supplier order;
- ask for clarification when a registered sender names another supplier's order;
- alert on invalid/uncertain interpretations rather than silently treating them as no change;
- suppress date/quantity proposals when the value already equals the recorded baseline;
- request clarification on combined date/quantity changes instead of silently keeping only one changed field;
- cache transient model failures as failed runs so retries can call the provider again;
- distinguish adapter-thrown schema errors from retryable request failures;
- notify the owner when extraction fails after its bounded attempts;
- reject altered evidence under the same external message identity;
- test email configuration, fake acceptance, retries, fixed recipients/body, idempotency windows and lease recovery.

Ambiguity tests supply a review-worthy model output; they do not prove that a live model will always produce one. The confidence threshold cannot detect all wrong high-confidence interpretations. Cancellation events, unit conversions, separate shipment milestones, authenticated approval and applying both changed fields together remain incomplete.

## Dashboard inspection

The Practice lab loaded all seven baselines and example suppliers. “Try this message” correctly prefilled the email source, sender, subject, original text and supplier sent time. Capture was opened and cancelled; no live analysis or approval was triggered through the browser. Desktop and phone layout were inspected separately.

## Reproduce and inspect

```bash
pnpm --filter @procurebrain/api evaluate:purchasing-agent
pnpm --filter @procurebrain/api test -- tests/purchasing-agent.test.ts
pnpm test
```

The complete local report is `.tmp/evaluations/purchasing-agent/offline-latest.json`. The [checked-in summary](2026-10-06-purchasing-agent.json) preserves pack/source hashes and case outcomes without duplicated full order snapshots. The code is currently an uncommitted working-tree snapshot; source hashes identify the files evaluated.

For an explicitly opted-in real model run, use `--live-ai --limit=5`; it may incur provider charges, but notification sending remains disabled in the isolated evaluation. See [the practice guide](../PURCHASING_PRACTICE_GUIDE.md) for detailed commands and interpretation.

## What this establishes

For these supplied outputs, the harness routes actionable changes, clarification requests and unchanged messages as expected, and regression checks exercise owner decisions and failure recovery. It does not establish real supplier-message accuracy, real inbox delivery, PostgreSQL durability or production readiness. Those need separate live evaluation and operational evidence.
