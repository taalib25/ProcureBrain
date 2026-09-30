# ProcureBrain: the problem, solution, and demo

## The problem in one sentence

When supplier dates or quantities change, procurement buyers can miss the change across order records and updates, then discover the delay or shortage only when it affects delivery.

This is the problem the project is designed to explore. It is a product hypothesis, not a claim that customer interviews or production data have validated it.

## Who it is for

The first intended user is a procurement buyer who tracks open purchase orders and needs to decide which supplier or order to follow up on next.

## The solution in one sentence

ProcureBrain organizes imported purchase-order activity into a current order view, a timeline, and an attention queue, with links back to the source evidence.

The useful question it should answer is: **“Which PO needs me, and what changed?”**

## What works in this prototype

1. Import a purchase order or later PO event from CSV.
2. Normalize the row into a typed operational event and retain its source record.
3. Replay the event history into the current PO state.
4. Derive attention items such as overdue delivery or quantity mismatch.
5. Open a PO to inspect its timeline and source evidence.
6. Separately, paste supplier text or upload a document to get a structured AI proposal for human review.

The CSV/event path and AI analysis path are currently separate. The AI proposal does **not** update the PO timeline. The prototype has no email inbox integration or approve-and-apply interaction yet. State these limits when presenting it.

## The clearest 15-second demo

**Hook:** “A supplier moved the delivery date. Would you notice before the order becomes late?”

1. Show a PO with its original ETA.
2. Import a supplier-update CSV row with the new ETA.
3. Show the PO's new ETA and the attention item or timeline entry.
4. Open the source evidence so the viewer can see what supports the change.

Keep the update date in the future if the goal is to show a changed ETA without also triggering an overdue flag. If demonstrating an overdue PO, use a past ETA deliberately and say that it is overdue.

For a separate AI example, paste a supplier message and show the proposal. Say: “This is a draft extraction for review; it has not been applied to the order.” Do not cut the two separate flows together as if the model automatically changed the PO.

## A simple presentation script

> Buyers often have to scan order records and supplier updates to work out what changed and what needs follow-up. ProcureBrain is an early prototype for making that easier: it turns imported PO activity into a timeline and attention queue, with source evidence attached. It can also extract a proposed update from supplier text, but a person still needs to review it, and the proposal does not yet update the order. I’m currently improving the evaluation and the end-to-end review workflow.

## Short CV wording

**ProcureBrain — Procurement operations prototype**

- Built a TypeScript application that imports purchase-order activity from CSV, replays events into current PO state, and surfaces deterministic exceptions such as overdue orders and quantity mismatches.
- Added source-linked PO timelines and a separate AI-assisted supplier-message extraction flow that returns reviewable proposals.
- Evaluated extraction on a 60-example synthetic holdout: 45% exact complete-record match; documented field-level results and review-routing limitations. The benchmark is synthetic and does not establish real-world performance.
- Project remains under active development; supplier-message proposals are not yet applied to operational records.

Only use the accuracy bullet when there is room to explain that it is a small synthetic benchmark and that exact-record match includes all required fields and review decision.

## Short public-facing tagline

**See which purchase orders need attention—and the evidence behind each one.**
