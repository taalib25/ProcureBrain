# ProcureBrain: dataset and code walkthrough

This guide explains what the project data represents, how one supplier message moves through the code, and what the current evaluation can and cannot tell us.

## 1. There are two different datasets

### Synthetic supplier-message benchmark

Files:

- `data/generated/supplier_messages.jsonl` — the message text sent to an extractor.
- `data/gold/expected_extractions.jsonl` — the expected structured answer or a label saying the message needs review.
- `data/splits/` — IDs and scenario families assigned to development, validation, and holdout.
- `packages/ai/src/dataset.ts` — the source templates that generate the benchmark.

This benchmark is **synthetic**. The code creates 30 message patterns, then makes 10 variations of each, for 300 messages total. For example, a pattern might be a direct shipping confirmation, a forwarded email with a corrected ETA, or a message with two conflicting quantities. These are useful controlled scenarios, but they are not 300 real supplier emails.

The split is grouped by whole message families:

| Split | Messages | Families | Gold entries requiring review |
| --- | ---: | ---: | ---: |
| Development | 180 | 18 | 50 |
| Validation | 60 | 6 | 0 |
| Holdout | 60 | 6 | 30 |

Keeping entire families in one split helps check whether the extractor handles scenario patterns it did not see during development. The holdout set should be kept for a final check after prompt or code changes. The validation set currently contains only extractable examples, so it does not measure how well the system abstains on ambiguous messages.

In the gold file, `expected: null` means the benchmark expects the system to stop and request human review. The scorer also treats an expected commitment with confidence below `0.7` as review-required because that is the application's review threshold. This differs from a valid, partial extraction: a message can have a missing PO number and still have extractable date or quantity fields.

This confidence-derived rule is retained to reproduce the historical benchmark. Future labels can set `reviewRequired` explicitly, based on a human decision. The October 1 audit makes all examples and known label issues visible: run `pnpm --filter @procurebrain/ai audit:dataset` and open `.tmp/evaluations/dataset-review.html`. New scoring separates adapter failures, invalid predictions, and missing answers from valid review decisions.

### Local purchase-order context corpus

Files under `data/datasets/` are local and Git-ignored. The processed corpus contains 2,777 records: 2,000 from a supply-chain dataset and 777 from a procurement-KPI dataset. They provide example PO facts that can be passed as `poContext` to extraction.

These records are **not paired with the synthetic supplier messages and are not extraction labels**. They cannot tell us whether an LLM correctly interpreted a supplier email. The separate company-document OCR archive is also not PO ground truth. See `packages/ai/README.md` for provenance and licensing notes.

## 2. What one benchmark row means

A generated message row has an ID, its text, its scenario family, and its split. The matching gold row has either:

- `expected`: the fields the extractor should return (`poReference`, `eta`, `quantity`, and business `type`), or
- `expected: null` plus a `reviewState` when the message is ambiguous or conflicting.

There are two different kinds of “type” in the application:

- `commitment.type` describes the supplier update: `new_commitment`, `eta_change`, `quantity_change`, or `general_update`.
- `proposal.state` describes the workflow decision: `VALID`, `LOW_CONFIDENCE`, `AMBIGUOUS_PO`, and other review states.

For example, `eta_change` can be a valid commitment type while `VALID` is the separate review state.

## 3. How a supplier message moves through the code

```text
Web form
  → POST /api/analysis/supplier-text (apps/api/src/app.ts)
  → configured provider (packages/ai/src/configured-provider.ts)
  → OpenRouter or OpenAI adapter
  → Zod schema validation (packages/ai/src/schema.ts)
  → reviewable EventProposal (packages/ai/src/adapter.ts)
  → versioned analysis cache
  → returned to the UI for human review
  → POST /api/analysis/runs/:cacheKey/approve after the owner approves an ETA
  → source record + canonical ETA event
  → PO reducer and exception queue update
```

The provider returns a proposed commitment. Zod checks that its shape is valid: dates use `YYYY-MM-DD`, quantities are nonnegative numbers or `null`, and the business type is one of the allowed values. `proposeSupplierCommitment` then assigns a workflow review state. The extraction endpoint only returns a proposal. When the owner selects the correct PO and approves an ETA, the separate approval endpoint checks the analysis run, confirms the extracted PO reference matches, atomically confirms the entire PO event revision still matches the analyzed state, stores the original supplier text, and records a canonical ETA event. The owner can edit the proposed ETA before approving. The event uses approval time, ordered after existing events if imported timestamps are in the future. The supplier's original send time is not collected. Retrying the same approval returns the saved event. Reusing a source ID with different content returns a conflict.

This approval flow is currently for pasted supplier text and ETA changes. Uploaded document analysis returns a result for inspection; it does not yet create an event. Automatic email and messaging connections are not implemented.

The CSV path is a separate, deterministic path. It normalizes rows into canonical events; the domain reducer replays those events into current PO state; the exception engine derives attention items. It does not use the LLM to calculate exceptions.

## 4. What the current evaluator measures

`apps/api/scripts/evaluate-supplier-extraction.ts` calls the configured provider once per example, builds reviewable proposals, and saves predictions plus run metadata under `.tmp/evaluations/`. `packages/ai/scripts/evaluate-dataset.ts` can also score an existing predictions JSON file without calling a model. `packages/ai/src/evaluate.ts` compares predictions with the gold file.

The report includes exact-match accuracy for each extracted field and for complete records. It separately reports the rate at which review-required rows receive a review proposal, and how often the system accepts one unsafely. A missing prediction is counted as unknown and incorrect; it is not counted as a successful human-review decision.

The first recorded holdout run is summarized in [the evaluation report](evaluations/2026-09-30-holdout.md). For a new run, the command is:

```bash
pnpm --filter @procurebrain/api evaluate:supplier-extraction -- --split=holdout
```

This makes one live provider request for each of the 60 holdout examples and may incur API charges. It records provider/model, prompt/schema versions, and reported token usage. This holdout has already been examined; use development and validation for changes and establish a new unseen evaluation set before making another final claim. Any score from this command describes this synthetic benchmark only, not real supplier traffic.

## 5. Suggested learning order

1. Read `packages/ai/src/dataset.ts` to see how each scenario and gold label is created.
2. Compare one message with its matching row in `data/gold/expected_extractions.jsonl`.
3. Read `packages/ai/src/schema.ts` to understand the allowed model output.
4. Follow `apps/api/src/app.ts` into `packages/ai/src/adapter.ts` to see validation and review-state assignment.
5. Read `packages/ai/src/evaluate.ts` to see how field, exact-record, and review-routing scores are calculated.
6. Read `packages/domain/src/reducer.ts` and `packages/domain/src/exceptions.ts` for the deterministic PO timeline and exception behavior.

## 6. What would make the accuracy claim stronger

Review the gold taxonomy against the prompt definitions using development data. The first holdout run also identified inconsistent business-type labels in `date-relative-only` and `quantity-unspecified`; see the [evaluation report](evaluations/2026-09-30-holdout.md). Keep the examined holdout untouched while tuning. Then collect a properly labeled set of real or representative supplier messages, split it by supplier or source when possible, and evaluate the extraction and review decision separately. Report the dataset, split, model, prompt/schema version, and exact metrics alongside any score.
