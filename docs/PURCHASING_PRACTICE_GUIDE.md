# Make ProcureBrain useful: purchasing practice guide

## Start with the owner's real job

You have ordered stock for your business. Your spreadsheet says it arrives November 10. A supplier changes the date to November 14 in a message you might overlook. ProcureBrain should identify that order, show the four-day delay, keep the source message, and prepare the changed record for your approval.

The useful outcome is **fewer missed changes and less manual retyping**, with clear evidence and control over what becomes an order fact. A model-generated answer alone does not demonstrate that outcome.

## Your first 10-minute walkthrough

1. Open **Practice lab** in the dashboard and choose **Load practice orders**. Seven clearly named `PO-PRACTICE-*` orders and six example suppliers are added. They are practice records; no existing order register is cleared.
2. Select **PC-01 — Four-day delivery delay**. Its baseline is 10 units of Vertex Ultra Widget from Vertex Beta GmbH, ETA **2026-11-10**.
3. Choose **Try this message**. The capture form is prefilled. Read it, then choose **Save & start agent** when ready. This uses the configured AI provider; email follows the current server configuration.
4. Open **Agent activity**. Expect one processing job and one prepared review alert. The alert should show the correct PO, supplier, old/new date, **+4 days**, source excerpt and review link.
5. Before approving, open the PO: its ETA must still be **2026-11-10**. Preparing an alert must not change an order.
6. Keep PC-01 pending for a moment. Try **PC-24** while the original November 10 baseline is still recorded: an on-track confirmation should stay quiet. Try **PC-09** to see why the agent must ask which of two orders the update belongs to.
7. Return to the PC-01 proposal and inspect its evidence. Approve, edit or reject it. Approval should set the ETA to **2026-11-14** and append one source-linked event. Repeating approval must not append another event.

Approvals change the baseline for subsequent manual cases. The dashboard warns when a practice baseline has changed. For independent test results, use the scenario runner, which creates a fresh isolated workspace for every case. In temporary memory mode, restarting the API discards all local records, including other demo work; it is not a selective reset feature.

## What we took from each dataset

| Dataset | Role in this pack | What it cannot establish |
| --- | --- | --- |
| Supply-chain PO corpus: 2,000 records | Six selected order records provide supplier names, products and quantities. One supplier has two open POs so matching can be tested. | Supplier-update extraction accuracy; these rows do not contain paired change messages. |
| Procurement-KPI corpus: 777 records | One pending 171-unit order becomes PC-33's 25-unit shortage scenario. | A confirmed promised date: its local normalized record has no planned delivery date. |
| 300 synthetic messages | Development patterns cover missing references, ambiguity, ranges and forwarded corrections. | Real supplier traffic or an independent score after using them for development. |
| 32 authored realistic messages | Tuning examples inspire clear delays, written dates, forwarded corrections and unclear commitments. | Collected real emails. The final split is left untouched. |

Practice order IDs, dates, contact addresses and all supplier messages are authored. The original source dataset and PO IDs are retained in `cases.json` and the import CSV. **Historical actual delivery dates are not supplied as promised ETA facts.** The KPI order's December 1 ETA is explicitly an authored practice baseline.

The old message labels are not blindly reused: “ships on” is different from “arrives on,” and a partial shipment's count is different from the total order quantity. Those distinctions are PC-19 and PC-34.

### Practice baselines

| Practice PO | Supplier | Product / category | Quantity | Authored ETA | Original record |
| --- | --- | --- | ---: | --- | --- |
| PO-PRACTICE-001 | Vertex Beta GmbH | Vertex Ultra Widget | 10 | 2026-11-10 | supply-chain: PO000001 |
| PO-PRACTICE-002 | Beta Delta LLC | Beta Prime Item | 5 | 2026-11-20 | supply-chain: PO000002 |
| PO-PRACTICE-003 | Beta Pioneer Inc | Nano Omega Device | 11 | 2026-11-15 | supply-chain: PO000003 |
| PO-PRACTICE-004 | Nova Beta Corp | Ultra Delta Device | 7 | 2026-11-25 | supply-chain: PO000004 |
| PO-PRACTICE-005 | Vertex Beta GmbH | Nano Beta Gadget | 16 | 2026-11-30 | supply-chain: PO000191 |
| PO-PRACTICE-006 | Gamma_Co | Raw Materials | 171 | 2026-12-01 | procurement-kpi: PO-00010 |
| PO-PRACTICE-007 | Quantum Fusion Corp | Prime Delta Item | 8 | Not recorded | supply-chain: PO000006 |

Product/category/unit cost and source identifiers remain in imported row evidence. The current extraction context primarily uses PO, supplier, quantity and ETA facts; retaining a field in evidence does not mean the agent already reasons about it.

## Files you can use immediately

- [Importable purchase orders](../data/scenarios/purchasing-agent/purchase-orders.csv)
- [Supplier setup records](../data/scenarios/purchasing-agent/suppliers.json)
- [All messages in a readable file](../data/scenarios/purchasing-agent/messages.txt)
- [Structured cases, expected behavior and provenance](../data/scenarios/purchasing-agent/cases.json)
- [Recorded offline evaluation](evaluations/2026-10-06-purchasing-agent.md)

## Scenario catalog

Each case has its message, sender, source pattern, business impact, expected disposition and gold-backed extraction fixture. **Proposal** means a draft plus an alert, **Review** means clarification with no approvable change, and **Quiet** means no changed-order alert. Every case requires the order to stay unchanged before owner approval.

| ID | Case | Expected behavior | Why it matters |
| --- | --- | --- | --- |
| PC-01 | Four-day delivery delay | Proposal | Prepare a draft and alert the owner; never apply it automatically. |
| PC-02 | Delivery arrives earlier | Proposal | Prepare a draft and alert the owner; never apply it automatically. |
| PC-03 | Written calendar date | Proposal | Prepare a draft and alert the owner; never apply it automatically. |
| PC-04 | Forwarded latest correction | Proposal | Prepare a draft and alert the owner; never apply it automatically. |
| PC-05 | Whole-order quantity reduced | Proposal | Prepare a draft and alert the owner; never apply it automatically. |
| PC-06 | First confirmed delivery date | Proposal | Prepare a draft and alert the owner; never apply it automatically. |
| PC-07 | No PO reference, one open supplier order | Proposal | Match the registered sender to its only open order, then prepare a draft. |
| PC-08 | Owner resolves a vague reference | Proposal | The owner explicitly selects PO-PRACTICE-004 before processing. |
| PC-09 | Two known orders in one update | Review | Ask for clarification and keep order facts unchanged. |
| PC-10 | Missing reference, several supplier orders | Review | Ask for clarification and keep order facts unchanged. |
| PC-11 | Unknown PO must not use supplier fallback | Review | An explicit unknown reference must not be replaced with another known order from the same supplier. |
| PC-12 | Confusable O and zero | Review | The letters OO2 are not the known numeric reference 002. |
| PC-13 | Unregistered sender without reference | Review | Ask for clarification and keep order facts unchanged. |
| PC-14 | Sender belongs to another supplier | Review | A registered supplier naming another supplier’s order needs clarification; an exact reference alone is insufficient. |
| PC-15 | Two possible delivery dates | Review | Ask for clarification and keep order facts unchanged. |
| PC-16 | Ambiguous numeric date | Review | Ask for clarification and keep order facts unchanged. |
| PC-17 | Relative date without delivery promise | Review | Ask for clarification and keep order facts unchanged. |
| PC-18 | Tentative conditional commitment | Review | Ask for clarification and keep order facts unchanged. |
| PC-19 | Shipment date is not arrival date | Quiet | Never overwrite the arrival ETA with the dispatch date. Corrected semantics rather than copying legacy shipment-date labels. |
| PC-20 | Unconfirmed quantity range | Review | Ask for clarification and keep order facts unchanged. |
| PC-21 | Body and attachment disagree | Review | Ask for clarification and keep order facts unchanged. |
| PC-22 | Cancellation is an alert, not a new ETA | Review | Notify the owner; keep the old date until a supported owner decision. This prototype does not implement cancellation events. |
| PC-23 | Important attachment is unavailable | Review | Ask the owner to upload/read the attachment rather than invent a new date. |
| PC-24 | On-track confirmation is quiet | Quiet | No proposal and no changed-order email when the date already equals the baseline. |
| PC-25 | Quantity already recorded | Quiet | Keep the evidence without an unnecessary change alert. |
| PC-26 | Routine progress without an action | Quiet | Keep the evidence without an unnecessary change alert. |
| PC-27 | Low confidence date needs owner review | Proposal | A LOW_CONFIDENCE proposal remains a draft, visibly requiring owner judgment. |
| PC-28 | Impossible date from the model | Review | Reject the invalid calendar date at the schema boundary and alert the owner. |
| PC-29 | Negative quantity from the model | Review | Reject negative quantities; do not create an approvable quantity proposal. |
| PC-30 | Malicious instructions inside supplier text | Proposal | Extract only the stated delivery change. No auto approval, tool invocation or recipient change. |
| PC-31 | Different units require clarification | Review | Do not treat cartons as pieces or infer a conversion factor. |
| PC-32 | Date and quantity change together | Review | The current proposal schema supports one field per run. Alert the owner to resolve the combined change; never silently drop the quantity change. |
| PC-33 | Large order shortfall from the KPI corpus | Proposal | Prepare a 146-unit total quantity proposal, preserving the December 1 delivery date. The 25-unit shortage is not a receipt. |
| PC-34 | Partial shipment is not a total reduction | Review | Ask the owner to clarify delivery milestones. Do not reduce the total order from 11 to 4, or treat dispatch as arrival. Multi-shipment modeling is not implemented. |

## Operational tests beyond the messages

The new `purchasing-agent.test.ts` includes the 34 message cases, a provenance/evidence audit and 24 workflow/runtime tests:

| Test area | Checks |
| --- | --- |
| Owner decisions | Approve once; repeat without another event; edit; reject; stale draft; quantity approval preserves ETA |
| Intake and matching | Duplicate intake/job; different evidence under one external ID; no relinking during work; owner resolves an ambiguous match; organization scope |
| AI request failures | Temporary failure calls the provider again after backoff; persistent failure stops after three attempts and prepares an owner alert; invalid structured output requests clarification without retrying transport |
| Email | Disabled/missing settings; fake provider acceptance; stable idempotency key and frozen recipient/body; three-attempt limit and explicit retry; expired uncertain sends blocked; configured preview alerts released |
| Worker recovery | Exclusive claims; old lease owner cannot finish replacement work; heartbeat; exhausted leases; replacement worker sharing the repository; overlapping cycles coalesce |

Four additional PostgreSQL tests are opt-in: concurrent deduplication, exclusive claims, lease reclamation/fencing and pending work after reconnect. Sharing an in-memory object with a replacement worker does not prove recovery across a process restart.

## Run the checks

### 1. Offline workflow evaluation — no provider cost or emails

From the repository root:

```bash
pnpm --filter @procurebrain/api evaluate:purchasing-agent
```

This runs all 34 cases with their supplied model outputs. It calls the actual capture, matching, queue, proposal and notification paths in fresh memory workspaces. It does not connect to the running dashboard, use a real mailbox, or send a real email. A failed expectation exits nonzero.

Inspect `.tmp/evaluations/purchasing-agent/offline-latest.json`. Each result includes individual checks and the observed disposition, model call count, draft fields, review state and outbox/job status. Expected evidence quotes must be present in the source.

Run a single case:

```bash
pnpm --filter @procurebrain/api evaluate:purchasing-agent -- --case=PC-01
```

### 2. Automated regression tests

```bash
pnpm --filter @procurebrain/api test -- tests/purchasing-agent.test.ts
pnpm test
```

The tests exercise approvals and fake provider failures in addition to the message pack. They make no real model or email requests. PostgreSQL tests run only when you set `PROCUREBRAIN_TEST_DATABASE_URL` to an appropriate test database. They create and remove a unique test schema, rather than clearing application tables.

### 3. Live model interpretation — opt in, notification previews only

Configure your provider locally, then explicitly add `--live-ai`. This makes real provider requests and may incur charges. The default live limit is five cases:

```bash
pnpm --filter @procurebrain/api evaluate:purchasing-agent -- --live-ai --limit=5
```

You can select one case with `--case=PC-01`. To evaluate the whole language pack, set `--limit=34`; the two deliberately invalid model-output fixture cases, PC-28 and PC-29, are excluded from live mode. The requested case limit is applied before that exclusion, so the full language run has 32 cases.

Live mode still creates isolated memory workspaces and keeps email disabled, regardless of the app's real email credentials. It runs one worker cycle per case; backoff/recovery behavior is covered in the offline runtime tests. It records observed outputs, checks, provider/model versions and available token usage in `.tmp/evaluations/purchasing-agent/live-latest.json`.

A correct mock tells us what the harness does **if extraction is correct**. The live run asks whether the configured model actually interprets these messages correctly. Neither is an unseen, representative real-world benchmark. Do not call a 34/34 offline result “100% AI accuracy.”

## Useful acceptance criteria for the owner

Before treating this as useful purchasing support, require:

1. The right PO, supplier, old/new value, date movement and evidence are shown for each explicit change.
2. Unknown or conflicting references ask for clarification; they never silently attach to another supplier's PO.
3. Ambiguous dates, tentative promises, incompatible units and missing attachments remain visible to the owner. The model must not turn them into confident order facts.
4. Unchanged promises and routine progress do not repeatedly interrupt the owner.
5. No order changes occur without the owner's decision; approvals remain idempotent and stale drafts are blocked.
6. A configured email reaches the actual owner with a reachable review link. Provider acceptance alone does not prove delivery.
7. Restarting a persistent deployment retains pending work. Test this with PostgreSQL; memory mode is temporary.

The current shape checks and confidence threshold cannot detect every semantically wrong high-confidence output. In particular, cancellation, conditions, attachment-only updates and unit conversions need live interpretation evaluation. Combined date/quantity changes are now explicitly routed to clarification; the prototype does not yet atomically apply both fields or model separate shipment milestones.

## Turn this into a small useful pilot

1. Demonstrate PC-01, PC-09 and PC-24 to the purchasing owner: a useful change, an uncertainty and a message that should stay quiet.
2. Run the five-case live dry run and inspect every result, then inspect the uncertainty cases before trusting them.
3. Collect permissioned, redacted examples of the owner's actual messages, including unchanged and unclear updates. Have a human record the intended order and action.
4. In a limited pilot, record missed changes, irrelevant alerts, wrong matches, owner edits and the time needed to review/update an order. Avoid inventing a time-saved figure.
5. Configure owner access, a reachable review URL and verified email; exercise delivery and recovery before depending on it for real purchasing decisions.

The next learning question is concrete: **Does ProcureBrain catch a change you would otherwise miss, and can you review it faster than finding the message and retyping it into your order record?**
