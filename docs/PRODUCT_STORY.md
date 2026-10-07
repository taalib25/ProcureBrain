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

1. Import purchase orders and later activity from CSV; retain source records and rebuild the current order timeline.
2. See deterministic attention items such as late delivery or quantity mismatch.
3. Save a supplier message, match it to an order, and request a structured AI proposal for review.
4. Approve or edit a supported date or quantity proposal. The approval appends a source-linked order event.
5. Inspect a supplier timeline made from saved messages and order events.
6. Use implemented connector code for read-only Gmail polling, a WhatsApp Business text webhook, or a signed normalized message receiver.

The Gmail connector has not been authorized against a real account. It still requires Google Cloud setup, local credentials, consent, PostgreSQL for durable checkpoints, and live validation. WhatsApp is also unconfigured; Outlook and personal WhatsApp connections are not built. See [the channel setup guide](CONNECTED_CHANNELS.md).

The AI can use a small amount of earlier supplier/order history that existed before the current message. Its proposal still needs owner approval. No supplier replies are sent. The current synthetic evaluation does not show real supplier-message accuracy.

## The clearest 15-second demo

**Hook:** “A supplier moved the delivery date. Would you notice before the order becomes late?”

1. Show a PO with its original ETA.
2. Open a saved supplier message (or add an example message) with the revised delivery date.
3. Show the saved date, proposed date, delay length, and original message.
4. Approve the proposal and show the updated PO timeline and attention item.

Keep the update date in the future if the goal is to show a changed ETA without also triggering an overdue flag. If demonstrating an overdue PO, use a past ETA deliberately and say that it is overdue.

The approval action records the user's decision; the model does not change the order by itself. Document uploads can be shown as a separate OCR analysis example until their approval flow is connected.

## A simple presentation script

> When you run a small business, purchasing is one of many things competing for your attention. A supplier can move a delivery date or change a quantity, and that update can get lost among messages and order records. ProcureBrain is an early prototype that tracks imported PO activity and can prepare a date or quantity change from supplier evidence for you to review and approve. The approved change is recorded with its source. Gmail sync and WhatsApp Business text intake have code, but no live accounts are connected yet.

## Short CV wording

**ProcureBrain — Procurement operations prototype**

- Built a TypeScript application that imports purchase-order activity from CSV, replays events into current PO state, and surfaces deterministic exceptions such as overdue orders and quantity mismatches.
- Added source-linked PO timelines and a human approval flow for date or quantity proposals from supplier messages.
- Evaluated extraction on a 60-example synthetic holdout: 45% exact complete-record match; documented field-level results and review-routing limitations. The benchmark is synthetic and does not establish real-world performance.
- Project remains under active development; live channel configuration, authenticated deployment, and evaluation on representative real messages remain incomplete.

Only use the accuracy bullet when there is room to explain that it is a small synthetic benchmark and that exact-record match includes all required fields and review decision.

## Short public-facing tagline

**See which purchase orders need attention—and the evidence behind each one.**
