# ProcureBrain: the problem, solution, and demo

## The problem in one sentence

When a supplier changes a delivery date or quantity, a small-business owner who also handles purchasing can miss the update among order records and messages, then discover the delay or shortage when it affects their business.

This is the problem the project is designed to explore. It is a product hypothesis, not a claim that customer interviews or production data have validated it.

## Who it is for

The first intended user is a small-business owner who places orders themselves and has to keep track of supplier promises alongside other responsibilities.

## The solution in one sentence

ProcureBrain organizes imported purchase-order activity into a current order view, a timeline, and an attention queue, with links back to the source evidence.

The useful question it should answer is: **“Which PO needs me, and what changed?”**

## What works in this prototype

1. Import a purchase order or later PO event from CSV.
2. Normalize the row into a typed operational event and retain its source record.
3. Replay the event history into the current PO state.
4. Derive attention items such as overdue delivery or quantity mismatch.
5. Open a PO to inspect its timeline and source evidence.
6. Paste supplier text, select a PO, and get a structured AI proposal beside the current ETA.
7. Review the original message, edit the proposed date if needed, and approve it to add an ETA event to that PO's timeline.

The approved pasted-text path now connects to the PO timeline. It still requires a person to select the PO and approve the proposed ETA. Uploaded document analysis has no approve-and-apply step yet. There is no automatic email or messaging connection, and the saved event time currently represents approval time, ordered after existing PO events when necessary. The supplier's original send time is not collected. State these limits when presenting it.

## The clearest 15-second demo

**Hook:** “A supplier moved the delivery date. Would you notice before the order becomes late?”

1. Show a PO with its original ETA.
2. Paste a supplier message with the revised ETA and select that PO.
3. Show the current date, proposed date, delay length, confidence, and original message.
4. Approve the proposal and show the updated PO timeline and attention item.

Keep the update date in the future if the goal is to show a changed ETA without also triggering an overdue flag. If demonstrating an overdue PO, use a past ETA deliberately and say that it is overdue.

The approval action records the user's decision; the model does not change the order by itself. Document uploads can be shown as a separate OCR analysis example until their approval flow is connected.

## A simple presentation script

> When you run a small business, purchasing is one of many things competing for your attention. A supplier can move a delivery date or change a quantity, and that update can get lost among messages and order records. ProcureBrain is an early prototype that tracks imported PO activity and can turn pasted supplier text into an ETA change for you to review and approve. The approved change is recorded with its source message. Automatic inbox connections and document approval are still future work.

## Short CV wording

**ProcureBrain — Procurement operations prototype**

- Built a TypeScript application that imports purchase-order activity from CSV, replays events into current PO state, and surfaces deterministic exceptions such as overdue orders and quantity mismatches.
- Added source-linked PO timelines and a human approval flow for ETA proposals extracted from pasted supplier messages.
- Evaluated extraction on a 60-example synthetic holdout: 45% exact complete-record match; documented field-level results and review-routing limitations. The benchmark is synthetic and does not establish real-world performance.
- Project remains under active development; document approvals, automatic channel connections, and evaluation on representative real messages remain incomplete.

Only use the accuracy bullet when there is room to explain that it is a small synthetic benchmark and that exact-record match includes all required fields and review decision.

## Short public-facing tagline

**See which purchase orders need attention—and the evidence behind each one.**
