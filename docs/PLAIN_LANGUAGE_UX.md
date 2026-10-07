# Plain language in ProcureBrain

## Who the screens serve

A person handling supplier orders who has little technical knowledge. The current workflow serves the person who buys goods and approves order updates. The app is still a prototype.

The main task is:

**Add message → Check change → Update order**

## What we learned from ASD-STE100

The [official ASD-STE100 overview](https://www.asd-ste100.org/about_STE.html) describes writing rules and a controlled dictionary. It recommends simple, recognizable words with consistent meanings. The standard also allows terms for a particular industry or project.

The [official guidance on STE tools](https://www.asd-ste100.org/STEsoftware.html) discusses checks for sentence length, passive voice, and word choice. Tools cannot check every rule or guarantee that readers understand a sentence.

We use these principles to guide the app's language. We have not audited every word against the official dictionary. **Do not describe ProcureBrain as ASD-STE100 compliant.**

## Writing rules for this app

1. Use a familiar word consistently. Do not alternate between draft, proposal, extraction, and suggestion for the same change.
2. Start instructions with the action: “Paste the message.” “Choose the order.”
3. Keep sentences short. Give one main instruction per sentence.
4. Name the result on a button. “Update delivery date” tells the user what will change.
5. Explain what happened and what to do next in an error.
6. Keep original supplier messages unchanged. Simplify our instructions, not the source evidence.
7. Put system details behind a disclosure. Do not hide an order mismatch, missing message, or other problem that affects the decision.
8. Use words with status colors. Never rely on color alone.
9. Explain uncertain outcomes precisely. An AI estimate is not measured accuracy. An accepted email is not confirmed inbox delivery.
10. Keep data-sharing information visible before checking a message or document.

## Shared terms

| Internal or previous wording | Everyday screen wording |
| --- | --- |
| Capture update | Add message |
| Save & start agent | Check message |
| Supplier inbox | Messages |
| Review queue | Check changes |
| Change proposal | Suggested change |
| Approve & apply ETA change | Update delivery date |
| Quantity approval | Update quantity |
| Reject proposal | Keep current order / Decline this change |
| Baseline ETA | Date before this change |
| ETA | Delivery date |
| Source evidence | Original message or file |
| Processing jobs | Message progress |
| Email outbox | Email alerts / Email previews |
| Model confidence | AI estimate, inside details |
| Invalid schema | Could not read the change |
| Analysis history | Technical history, under More options |

“Supplier” and “order” are necessary purchasing terms. Actual order numbers such as PO-1001 remain unchanged.

## Simpler screens

- Six main menu items. Connections, file upload, examples, saved originals, technical history, and project details remain under More options.
- A message form starts with the text and an optional order choice. Extra source details are optional. Choosing email, WhatsApp, or text message still requires a sender.
- Home shows pending changes before recorded order problems when pending changes exist.
- Review shows the saved date or quantity, suggested value, source message, and explicit decision buttons.
- Message status distinguishes a suggested change, a finished check with no change, and a request for help.
- Connection setup is under More options. The page distinguishes configured channels from channels that need setup. Email preview explicitly says no email is sent.
- The example page starts with three messages. All 34 examples remain available.
- Spreadsheet text is secondary to file upload. Check file comes before Add to orders. Adding spreadsheet records updates order records directly; supplier-message approvals are a separate flow.

## Checks for this change

Workspace type checking and the web production build passed. Browser inspection covered eight task screens at 320, 375, 414, 768, and 1440 pixels. The message form and its required sender field were inspected. The populated approval flow and live email delivery were not exercised. Do not infer improved AI accuracy or proven usability from these checks. A useful next user session is to ask a nontechnical person to add a sample message, find the suggested date, and explain what Update delivery date will do.

Existing saved emails keep their original wording. New alerts use the revised wording.
