# Purchasing dashboard

The dashboard is an under-development review workspace for one small-business purchasing owner. It uses the API for order records, messages, proposals, suppliers, connections, and source evidence. It does not represent that external accounts are connected when they have only been implemented.

## Open it locally

```bash
pnpm --filter @procurebrain/api dev
pnpm --filter @procurebrain/web dev --host 0.0.0.0
```

Open `http://localhost:5173`. Without `DATABASE_URL`, the API uses memory storage and records reset when it restarts. Gmail setup is described in [Connected supplier messages](CONNECTED_CHANNELS.md).

## Everyday pages

| Page | What it is for |
| --- | --- |
| Home | See saved orders, issues, pending changes, and upcoming deliveries. |
| Orders | Find an order and inspect its current values, history, and original evidence. |
| Messages | See supplier messages. A person can save one manually; a connected channel can bring it in automatically after setup. Review how ProcureBrain matched the order and checked the message. |
| Check changes | Compare the message with the saved value. Approve a supported date or quantity update, edit it, or decline it. |
| Email alerts | See background message progress and email previews. A preview is not a sent or delivered email. |
| Suppliers | Manage supplier records and open a source-linked supplier history. |

**Connections** appears under **More options**. It reports whether Gmail is set up, paused, or needs attention. The page also describes the WhatsApp Business text receiver and the signed intake for a custom connector. A badge reading Setup needed means no live service is connected.

Other pages under More options include adding orders/files, sample cases, saved originals, technical history, and project details.

## What supplier history means

A supplier history combines saved source messages and order events with their dates. When analyzing a new message, ProcureBrain can include a limited set of earlier related messages and order changes up to the new message's sent time. The original message remains the evidence for the current proposal. This helps preserve a timeline; it is not a learned supplier profile or reliability score.

## Current boundaries

- Gmail uses read-only access, checks once per minute while the API service runs, and needs the local Google setup steps. Its first two-week history import is kept as history without automatic analysis.
- WhatsApp currently handles business-platform text messages only and is not configured. There is no connection to personal WhatsApp history and no WhatsApp alert sending.
- Other services need their own adapter to the signed receiver. Outlook is not connected.
- New messages that are analyzed send their content and bounded context to the configured AI provider.
- Email attachments are not read by the Gmail adapter. Old messages with a file are kept for a person to inspect.
- Memory storage resets on API restart. Authentication, complete tenant protection, and production readiness are unfinished.

The visual design uses familiar words and the existing ProcureBrain theme. It is guided by selected plain-language principles; it has not been audited as compliant with ASD-STE100. See [Plain-language notes](PLAIN_LANGUAGE_UX.md).
