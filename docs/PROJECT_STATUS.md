# ProcureBrain: current status

**Status: under active development.** This is a learning prototype for a small-business owner who handles purchasing. It aims to catch supplier changes, connect them to the right order, and prepare a clear change for the owner to review.

## What is built

- Purchase order and activity CSV import, source records, event timelines, and deterministic checks for late orders and quantity issues.
- Supplier messages can be saved, matched to an order, analyzed in a background worker, and turned into a reviewable date or quantity proposal.
- The owner can approve, edit, or decline a proposed change. Approval appends an order event with source evidence.
- Gmail read-only OAuth setup, minute-based polling, a two-week initial message history, incremental checkpoints, pause/resume, deduplication, and history recovery are implemented. No real Gmail account has been connected or live-validated.
- WhatsApp Business webhook handling is implemented for signed text messages. Account configuration, supplier tests, and live validation remain undone. It does not read personal chats, voice notes, images, or attachments, and it does not send WhatsApp alerts.
- A signed message receiver can accept a normalized message from a separate integration. It is not a ready-made Outlook, Slack, or email adapter.
- Supplier pages show saved messages and order events as a source-linked timeline. AI analysis may use bounded earlier history from the same supplier/order, limited to what was known at the message time.
- A dashboard provides Home, Orders, Messages, Check changes, Email alerts, Suppliers, and Connections screens.
- A synthetic extraction dataset and 34 authored workflow scenarios support learning and evaluation. Fixture-driven workflow results do not measure AI understanding or real supplier accuracy.

## What a user can do now

With demo or configured API data, a user can inspect orders and evidence, save a supplier message, review an AI proposal, and approve an order change. The dashboard includes a Connections page, but Gmail will say **Setup needed** until an owner completes Google Cloud and OAuth setup. A configured connection still needs live validation before it is relied on.

## What remains

1. Register and verify supplier email and phone details and purchase-order baselines.
2. Create a Google Cloud project, enable Gmail API, configure an OAuth consent screen and desktop client, add test user access if needed, and authorize the local setup command. Credentials must stay in local `.env`.
3. Use PostgreSQL and validate the new connector-state migration, polling, restart recovery, duplicate messages, pause/resume, and OAuth revocation.
4. Review privacy and data handling. New supplier messages and bounded context go to the configured AI provider. Gmail requests a restricted read-only scope.
5. Evaluate proposal correctness and safe review routing with representative, permissioned supplier messages. Existing synthetic scores are not real-world accuracy.
6. Add authenticated owner access and complete organization boundaries before exposing business records publicly.
7. Configure and verify owner email alerts. Add WhatsApp Business setup only if supplier feedback supports it. Add ready-made Outlook or other adapters only when needed.
8. Decide how long message evidence is kept, how owners delete it, and how backup and monitoring will work.

Full design, message flow, and an ordered Gmail checklist are in [Connected supplier messages](CONNECTED_CHANNELS.md). The step-by-step agent flow is in [Agent harness](AGENT_HARNESS.md).

## Validation done and limits

The workspace type check and web production build passed during this implementation. Browser inspection covered the Connections page at desktop and 320-pixel width. No Gmail account, WhatsApp account, live AI request, outgoing email, or production database recovery was exercised in this iteration. No new AI-accuracy result is claimed.

The October 6 workflow pack reports 34/34 offline purchasing cases with fixture extraction outputs. This confirms expected workflow handling for those supplied outputs; it does not test whether an AI model extracts the correct changes. The separate synthetic extraction benchmark has known label limitations; see the [dataset and evaluation notes](../packages/ai/README.md).
