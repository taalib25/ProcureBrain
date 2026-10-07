# Connected supplier messages

**Status: implementation exists; live accounts are not connected or verified.** Gmail polling and OAuth setup, a WhatsApp Business text receiver, a signed message receiver for other systems, supplier history, and review safeguards are in the code. They need provider accounts, local configuration, and live validation before anyone relies on them. ProcureBrain remains under development.

## Why this exists

A small-business owner may receive a supplier's new delivery date in email or a message, then need to find the matching purchase order and update a separate record. ProcureBrain is meant to gather the evidence, explain the proposed change, and prepare an order update for the owner's review. It does not reply to suppliers or update the order before approval.

```mermaid
flowchart TD
  Gmail[Gmail inbox] -->|read only polling| Normalize[Normalize message and keep provider ID]
  WhatsApp[WhatsApp Business webhook] -->|verified text only| Normalize
  Other[Signed message receiver] --> Normalize
  Normalize --> Match[Match a registered supplier]
  Match -->|unknown or ambiguous| Saved[Save safely or skip; ask owner to resolve]
  Match -->|one supplier| History[Save original message and source link]
  Orders[POs, suppliers, and approved order events] --> History
  History --> Context[Build bounded supplier and order history as of message time]
  Context --> Interpret[AI checks the current message against the order]
  Interpret --> Guard[Validate fields, evidence, dates, and newer updates]
  Guard -->|unclear, late, or unsupported| Help[Show message and ask for help]
  Guard -->|clear change| Proposal[Prepare a reviewable change]
  Proposal --> Notify[Show in Check changes and prepare owner alert]
  Notify --> Decide{Owner decision}
  Decide -->|approve or edit and approve| Event[Append source linked PO event]
  Decide -->|decline| Keep[Keep saved PO values]
  Event --> History
  Keep --> History
```

The timeline is the app's working memory: supplier messages retain their source record and order events retain their source link. For AI analysis, the app can pass up to eight earlier related messages (up to 1,500 characters each) and twelve earlier order events. It uses the supplier, order reference, selected order, and thread to limit history. It excludes later events from a message's context. The current message remains the evidence for a new proposed commitment; old promises are background only. This is bounded evidence reuse, not a model that learns a supplier's behavior or maintains general conversational memory.

## What is in the code

| Part | Current behavior | Still needed |
| --- | --- | --- |
| Gmail | Read-only Google OAuth; polls every minute; first saves up to two weeks of supplier mail as history without automatically checking it; then checks new mail. Stable message IDs, saved sync checkpoints, a database lock, duplicate handling, pause/resume, and history-expiry recovery are implemented. | Google Cloud setup, user consent, credentials in local `.env`, persistent database for durable history, and a live connection/restart check. No push notifications; the API service must stay running. |
| Supplier matching | Uses a unique supplier email or phone. Domain matching is limited to a unique non-public email domain. Unknown or ambiguous identities are not assigned to a supplier. | Add and review correct supplier contacts and order records. Check sender identity and forwarded-message behavior with real cases. |
| Message history | Original messages and provider IDs are saved and deduplicated. Supplier page combines messages and order events in date order. | Decide retention/deletion and access rules before live business use. Large histories need indexed queries and paging. |
| AI context | Sends a limited, source-linked history and order baseline to the configured AI provider. Clear relative dates can use the message sent time and configured timezone. Old messages and unread attachments cannot create an approvable update. | Validate with permissioned real mail. Message text and bounded history leave the app for the configured AI provider. Review provider data settings before using private business data. |
| Approval | A clear proposal appears for owner review. Applying it still needs the explicit existing approval action. A later valid update to the same field marks an older pending suggestion outdated. | Authenticated owner identity and full tenant boundaries are required before a public deployment. |
| WhatsApp Business | A Meta webhook validates the verification challenge and request signature. It accepts text messages from registered supplier phone numbers. | Business account, public HTTPS API address, webhook configuration, secrets, and live validation. Personal chat history, username-only contacts, audio, image and document reading are not supported. No WhatsApp alerts or replies are implemented. |
| Other channels | A signed, timestamped, size-limited JSON intake exists for services that can send the documented message format. | This is a gateway, not a ready-made Outlook, Slack, forwarding, or email connection. Each source needs an adapter, setup, and live check. |
| Owner alerts | Existing email preview/outbox workflow can show proposal alerts. | Configure and validate delivery. A provider accepting an email does not prove it arrived. |

Email bodies are stored as text. The Gmail adapter prefers plain text. If an email only has HTML, its raw markup is retained as text; it is not converted into clean readable text. Attachment names are recorded, but attachment contents are not downloaded, scanned, or read. Such messages are kept for a person to inspect and cannot yield an approved change from the attachment.

## Run the Gmail setup locally

The setup command opens Google's consent page in your normal browser. It uses a local callback at `http://127.0.0.1:8788/callback`, state validation, PKCE, and the read-only `gmail.readonly` scope. The refresh token is written to the local `.env` with restricted file permissions; it is not printed or written to this repository. Do not send credentials in chat or commit `.env`.

1. In Google Cloud Console, create or choose a project and enable the Gmail API.
2. Configure the OAuth consent screen and create an OAuth client of type **Desktop app** for this local loopback setup. Add yourself as a test user if the consent screen is in testing. Google classifies `gmail.readonly` as a **restricted** scope. Google verification and, for a service that stores/transmits restricted data, a security assessment may be required before public use. Check Google's current requirements before publishing this connection.
3. Copy the client ID and client secret to the local `.env` only:

   ```dotenv
   GMAIL_CLIENT_ID=your-client-id
   GMAIL_CLIENT_SECRET=your-client-secret
   PROCUREBRAIN_GMAIL_ENABLED=false
   ```

4. Add suppliers and their email addresses to ProcureBrain. Add or check the matching purchase orders and saved delivery dates.
5. In a terminal at the project root, run:

   ```bash
   pnpm --filter @procurebrain/api connect:gmail
   ```

6. Open the printed Google consent link in a browser on the same computer. Grant read-only Gmail access. The command saves `GMAIL_REFRESH_TOKEN` and turns on Gmail reading in `.env`.
7. Configure `DATABASE_URL` for records that must survive API restarts. Restart the API. Open **Connections**, check that the account is shown, and start with the history import. Past messages are saved as history; check them yourself from **Messages** if you want to analyze one. New messages are checked on the next polling cycle.
8. Inspect the original message, order match, proposal, and source timeline. Verify pause/resume and restart behavior before using this for real purchasing.

The initial two-week history is **not** automatically sent to AI. New supplier messages are sent to the configured AI provider for analysis. Supplier replies remain disabled. If Google access is revoked or the connection fails, check **Connections** and reconnect.

For an external OAuth consent screen left in **Testing**, Google says refresh tokens for Gmail scopes expire after seven days. Plan to reconnect during development, or complete the publishing and verification requirements before relying on longer-running access.

## Other settings

Keep these values in the local `.env`. `.env.example` has blank placeholders only.

```dotenv
PROCUREBRAIN_AGENT_ORG=org-dev
PROCUREBRAIN_TIMEZONE=Asia/Colombo
DATABASE_URL=postgresql://user:password@localhost:5432/procurebrain
PROCUREBRAIN_GMAIL_ENABLED=false
PROCUREBRAIN_WHATSAPP_ENABLED=false
WHATSAPP_APP_SECRET=
WHATSAPP_VERIFY_TOKEN=
WHATSAPP_PHONE_NUMBER_ID=
PROCUREBRAIN_INBOUND_SECRET=
```

The API applies migration `0007_connector_state.sql` to PostgreSQL at startup. Memory mode loses saved messages, history, proposals, and connection checkpoints when the API restarts. A persistent database is necessary for dependable ongoing use.

For a custom sender, post a JSON message to `/api/connectors/webhook/{name}` and sign `timestamp + "." + rawBody` with HMAC-SHA256 using `PROCUREBRAIN_INBOUND_SECRET`. Send the Unix timestamp in `x-procurebrain-timestamp` and `sha256=<hex>` in `x-procurebrain-signature`. Requests older than five minutes, larger than 1 MiB, malformed, or incorrectly signed are rejected. See `apps/api/src/connectors/routes.ts` for the exact schema. Do not expose this endpoint until an authenticated deployment and secret-management plan are in place.

## Learn the implementation

- `apps/api/src/connectors/gmail.ts` — Gmail polling, history checkpoints, and message parsing.
- `apps/api/scripts/connect-gmail.ts` — local Google OAuth and `.env` update.
- `apps/api/src/connectors/routes.ts` — connection status, controls, WhatsApp webhook, and signed intake.
- `apps/api/src/connectors/ingest.ts` — supplier matching, stable IDs, storage, and background queueing.
- `apps/api/src/connectors/repository.ts` — durable sync state and PostgreSQL worker lock.
- `apps/api/src/connectors/context.ts` — supplier/order history and message-time context.
- `packages/ai/src/communication-context.ts` — context format and instructions to treat message history as untrusted evidence.
- `apps/web/src/pages/connections.tsx` and `apps/web/src/components/supplier-history.tsx` — simple connection status and supplier history views.

## Open setup and validation list

Complete these in order before describing ProcureBrain as a live service:

1. Add accurate suppliers, contact addresses, and order baselines. Review whether sender/domain matching fits the suppliers who will use it.
2. Set up the Google Cloud project, Gmail API, OAuth consent, Desktop app client, and test-user access. Put credentials only in local `.env` and complete the consent steps above.
3. Use PostgreSQL for durable message, event, proposal, outbox, and checkpoint storage. Confirm access, backup, retention, and deletion policies.
4. Select and configure the AI provider. Decide which private message data may be sent to it and review its data-handling terms and settings.
5. Exercise Gmail history import, new mail polling, duplicate delivery, pause/resume, OAuth revocation, provider failure, and API restart recovery with a safe test account. Measure extraction and safe-review accuracy separately on representative, permissioned supplier messages. The existing synthetic evaluation does not measure the Gmail connector or real-world accuracy.
6. Add owner authentication, enforce organization boundaries across every API route, protect webhook secrets, and set up monitoring before a public deployment. The current organization header is not authentication.
7. Configure and verify owner email alerts. Confirm delivery with a real test address; a saved preview or provider acceptance is not delivery confirmation.
8. Add WhatsApp Business only if owners need it: configure the public HTTPS webhook, business phone ID, verification token, app secret, and test supplier phone numbers. Review and implement a separate outbound alert path only if needed.
9. Add service-specific adapters for Outlook or other sources based on actual owner use. Keep the same source evidence, supplier match, timeline, and approval flow.

## References

- [Gmail API synchronization guide](https://developers.google.com/workspace/gmail/api/guides/sync) — message history, incremental sync, and resynchronization.
- [Gmail API OAuth scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) — requested access and restricted-scope classification.
- [Google OAuth desktop app flow](https://developers.google.com/identity/protocols/oauth2/native-app) — installed applications and local callback setup.
- [Google restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) — current review and assessment requirements.
- [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration) — reasons a refresh token can stop working, including seven-day expiration for external apps in Testing.
- [Meta WhatsApp webhook signature sample](https://github.com/fbsamples/whatsapp-api-examples/blob/main/signature-validation-with-webhooks-payloads/app.py) — signature validation example.
