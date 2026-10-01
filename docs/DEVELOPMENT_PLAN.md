# ProcureBrain Development Plan

> Branch: `develop`  
> Review date: 2026-10-01  
> Scope: deep technical review of the current repository plus an API-first roadmap for evolving ProcureBrain into a procurement-by-exception system.
>
> This document distinguishes **what exists today** from **what is proposed**. It is intentionally implementation-focused. It does not claim the current prototype is production-ready.

---

## 1. Product direction

### Core product thesis

ProcureBrain should not try to become a generic "AI procurement assistant" or a chat layer over purchase-order data.

The sharper product is:

> **Procurement by exception:** ProcureBrain continuously turns supplier activity into structured operational state, applies deterministic business rules, and shows a procurement person only the changes, risks, approvals, and follow-ups that actually need human judgment.

The target workflow is:

```text
supplier communication / import / receipt
                |
                v
        immutable source evidence
                |
                v
      deterministic identity + PO match
                |
                v
       AI interpretation when needed
                |
                v
       validated change proposal
                |
                v
        human review / approval
                |
                v
       canonical operational event
                |
                v
        purchase-order projection
                |
                v
     deterministic attention engine
                |
                v
       "what needs me today?"
```

The important separation is:

- **AI interprets ambiguous supplier language.**
- **Application code owns state, policy, calculations, approvals, audit history, and side effects.**
- **Humans approve material commitments until the system has enough evidence and policy coverage to safely automate a specific action.**

That separation already exists in the current repository and should be preserved.

---

## 2. Current repository review

### 2.1 What is already strong

The current codebase is substantially better than a typical prototype because the core operational truth is not delegated to an LLM.

The repository currently has:

- a pnpm TypeScript monorepo;
- Hono API;
- React/Vite UI;
- PostgreSQL support;
- Drizzle schemas for persisted data;
- event-sourced purchase-order history;
- deterministic reducers for current PO state;
- deterministic exception detection;
- CSV ingestion with normalization and idempotency;
- immutable source evidence;
- OpenRouter/OpenAI extraction adapters;
- Zod validation at AI and HTTP boundaries;
- a versioned analysis cache;
- cache fencing/leases for concurrent model work;
- human approval before an AI-derived ETA becomes a canonical PO event;
- stale-draft protection through a PO revision hash;
- per-PO PostgreSQL advisory transaction locks;
- explicit source identity conflict handling;
- synthetic AI evaluation tooling;
- OCR-first document extraction with vision fallback for supported image paths;
- real PostgreSQL concurrency regression tests when a test database is configured.

This is a good foundation. The direction should be to **extend the domain carefully**, not rewrite the project around agents.

### 2.2 Current package boundaries

Current structure:

```text
apps/
  api/
    Hono runtime
    HTTP routes
    PostgreSQL + memory stores
    OCR worker integration
  web/
    React/Vite prototype UI

packages/
  domain/
    canonical event contracts
    PO reducer
    exception engine
    priority

  ingestion/
    CSV parsing
    normalization
    PO entity resolution
    idempotency

  db/
    Drizzle schema
    durable analysis-cache repository

  analysis-cache/
    versioned cache identity
    in-memory cache
    durable claim/lease/fencing logic

  ai/
    schemas
    model adapters
    provider configuration
    PO context utilities
    synthetic dataset + evaluation

  evals/
    deterministic exception/integration tests
```

The boundary principle in `docs/ARCHITECTURE.md` is correct: domain logic is pure TypeScript, AI adapters do not write canonical events, and HTTP/framework code stays outside the domain.

### 2.3 Current PO event model

Current event types:

```text
PO_CREATED
SUPPLIER_ETA_CONFIRMED
SUPPLIER_ETA_CHANGED
SUPPLIER_QUANTITY_CONFIRMED
SUPPLIER_QUANTITY_REDUCED
GOODS_RECEIVED
FOLLOWUP_SENT
SUPPLIER_RESPONSE_RECEIVED
```

Current purchase-order state includes:

```text
supplier identity
ordered quantity
confirmed / reduced quantity
received quantity
ETA
receipt status
follow-up count
supplier responses
applied event IDs
last operational timestamp
```

This is enough to demonstrate a real event-sourced operational workflow.

### 2.4 Current attention rules

The deterministic exception engine currently derives:

```text
ETA_CHANGED
LATE_PO
QUANTITY_SHORT
RECEIPT_SHORT
FOLLOWUP_OVERDUE
```

This is the beginning of the product's most valuable layer.

Do not replace this with an "AI risk agent." Expand deterministic rules whenever a rule can be expressed from known facts.

### 2.5 Current AI boundary

The current model output shape is intentionally narrow:

```text
poReference
eta
quantity
type
confidence
evidence[]
```

The API validates this through Zod and turns it into a reviewable proposal.

For the pasted-text ETA flow:

1. selected PO state is loaded;
2. current ETA and revision are snapshotted into the analysis request;
3. the model returns a structured commitment;
4. the proposal is returned to the user;
5. approval rechecks the PO reference, date, and baseline revision;
6. a source record is persisted;
7. a canonical ETA event is appended;
8. current PO state and exceptions are recomputed.

This is a sound pattern and should become the standard pattern for future AI-derived operational changes.

---

## 3. Main technical gaps in the current implementation

These are the gaps that matter before the product expands.

### 3.1 Supplier communication is not a first-class domain object

Today, pasted supplier text becomes generic source evidence and an analysis run. There is no durable `supplier_messages` entity containing:

- channel;
- external message ID;
- sender;
- recipient;
- subject;
- supplier;
- sent timestamp;
- received timestamp;
- thread;
- processing state;
- candidate POs;
- final linked PO(s).

This prevents the system from becoming a real procurement inbox.

**Recommendation:** introduce a supplier-message layer while retaining `source_records` as immutable raw evidence.

### 3.2 PO context is supported but not automatically derived from the selected operational PO

The API accepts optional `poContext`, but the normal web flow does not automatically construct model context from the actual selected PO and its relevant history.

The model should not rely on a caller manually supplying a separate local dataset record when the application already owns the PO.

**Recommendation:** add an application service that builds a compact factual model context from the current PO projection and relevant recent events.

Example:

```json
{
  "poNumber": "PO-1001",
  "supplier": "Northstar Components",
  "orderedQuantity": 100,
  "confirmedQuantity": 100,
  "currentEta": "2026-10-08",
  "recentEvents": [
    {
      "type": "SUPPLIER_ETA_CONFIRMED",
      "eta": "2026-10-08"
    }
  ]
}
```

The model sees this as baseline context. The supplier message remains the only proposal evidence.

### 3.3 PostgreSQL reads currently replay too much data

The current `PostgresStore` implementation uses `allEvents()` in several important reads.

Examples:

- `purchaseOrders()` loads all canonical events and filters them in application memory.
- `state(id)` loads all events, then filters one PO.
- `timeline(id)` loads all events, then filters one PO.
- `exceptions()` loads the complete event stream.

This is acceptable for the prototype but will become the first database performance problem as history grows.

**Short-term fix:** query `canonical_events where entity_id = $1 order by occurred_at,id` for per-PO reads.

**Medium-term fix:** maintain a transactional purchase-order projection table so list screens do not replay every event.

Event history remains the audit source of truth; projection tables are query models.

### 3.4 `purchase_orders` is currently an identity table, not a real projection

Current persisted columns are only:

```text
entity_id
po_number
supplier_id
supplier_name
```

Current quantities, ETA, status, and revision are reconstructed from events.

That is clean for correctness, but list endpoints will eventually need a materialized read model.

Do not silently turn the existing table into an uncontrolled mutable source of truth.

Instead, explicitly define:

- `purchase_orders`: aggregate identity and durable metadata;
- `purchase_order_projection`: latest replayed state for fast reads;
- `canonical_events`: immutable operational truth.

### 3.5 There is no organization boundary

There is currently no:

- organization table;
- user table;
- organization ID on operational records;
- access-control layer;
- tenant-aware uniqueness constraint.

Before storing real company procurement traffic, tenancy needs to be introduced.

This should happen before email integration is used with real organizations because retrofitting tenant keys into every source, event, message, analysis, and proposal is expensive.

### 3.6 Supplier is not a real entity yet

Supplier identity currently lives mainly as fields on PO metadata/events.

A procurement system needs a supplier aggregate because future workflows depend on it:

- email matching;
- supplier performance;
- quotation comparison;
- follow-up history;
- claims/issues;
- payment terms;
- lead-time expectations;
- country/currency;
- active/blocked status.

### 3.7 Attention has no persistent workflow state

Exceptions are correctly derived from events, but a user will need to:

- acknowledge;
- snooze;
- assign;
- resolve;
- dismiss;
- add a note.

Do **not** make a mutable `attention_items` table the new truth for whether an operational risk exists.

Recommended model:

```text
derived exception
      +
attention action/state
      =
UI attention item
```

Keep risk detection deterministic. Persist only the user's workflow state against a stable exception key.

### 3.8 The approval system is ETA-specific

The existing approval endpoint and `ApprovedEtaChange` are safe but narrow.

The next architecture should generalize **proposal lifecycle**, not generalize the LLM into arbitrary JSON patching.

A proposal should have an explicitly supported type:

```text
ETA_CHANGE
QUANTITY_CHANGE
SUPPLIER_CONFIRMATION
QUOTE_IMPORT
FOLLOWUP_DRAFT
```

Each proposal type gets:

- its own schema;
- deterministic validation;
- explicit allowed side effects;
- explicit approval handler.

Never accept a model-produced arbitrary database mutation.

### 3.9 Source and analysis storage will contain sensitive business data

The current design can retain supplier content in multiple locations:

- `source_records.content`;
- `analysis_inputs.content`;
- analysis request/model request metadata;
- possibly OCR/model request payloads.

For a prototype this is useful for replay/evaluation. For business use it creates retention/privacy obligations.

A production data policy is needed for:

- which raw inputs are stored;
- how long they are retained;
- whether full model payloads are retained;
- redaction;
- deletion;
- encryption at rest;
- export;
- audit access;
- logs.

### 3.10 Current AI confidence is not calibrated

The current review logic includes a confidence threshold. The repository itself correctly notes that the confidence value is a model estimate, not a measured probability.

Future review routing should rely primarily on hard conditions:

- no PO match;
- more than one PO candidate;
- extracted PO conflicts with deterministic match;
- unsupported date;
- conflicting values;
- missing evidence;
- source already processed;
- stale PO revision;
- type/action unsupported.

A model confidence threshold may remain a secondary signal after calibration on representative data.

### 3.11 The evaluation set is not enough for business-use claims

Current synthetic benchmark work is useful for regression, but it is not representative supplier traffic. The historical holdout has already been examined and has known label issues.

Before reducing human review, create a permissioned/redacted evaluation set and measure:

- PO matching accuracy;
- ETA field accuracy;
- quantity field accuracy;
- evidence support;
- missed material update rate;
- review recall;
- unnecessary review rate;
- unsafe-accept rate;
- proposal approval-without-edit rate.

---

## 4. Architecture decision: keep the modular monolith

Do not introduce microservices.

Recommended V1 shape:

```text
React / API client
       |
       v
Hono API
       |
       +---------------------------+
       |                           |
       v                           v
application services          background jobs
       |                           |
       +------------+--------------+
                    |
                    v
              repositories
                    |
                    v
                PostgreSQL

application services
       |
       +--> pure domain package
       |
       +--> AI adapters
       |
       +--> email/channel adapters
```

One deployable backend is enough.

A separate worker process is optional later, but it can use the same codebase and database.

---

## 5. Proposed repository structure

Do not perform a large rewrite in one commit. Move toward this incrementally:

```text
apps/api/src/
  app.ts
  server.ts
  runtime.ts

  routes/
    health.ts
    purchase-orders.ts
    suppliers.ts
    messages.ts
    proposals.ts
    attention.ts
    imports.ts
    quotations.ts
    integrations.ts

  services/
    purchase-order-service.ts
    supplier-message-service.ts
    proposal-service.ts
    attention-service.ts
    quotation-service.ts
    followup-service.ts

  repositories/
    types.ts

  jobs/
    worker.ts
    handlers/
      process-supplier-message.ts
      recalculate-projection.ts
      sync-email.ts

packages/domain/src/
  events.ts
  purchase-order.ts
  reducer.ts
  exceptions.ts
  proposals/
  suppliers/
  quotations/

packages/db/src/
  schema.ts
  repositories/
    purchase-orders.ts
    events.ts
    source-records.ts
    suppliers.ts
    messages.ts
    proposals.ts
    attention.ts
    quotations.ts

packages/ai/src/
  schema.ts
  adapters/
  prompts/
  evaluation/
```

The first refactor should be extracting interfaces/services, not moving every file immediately.

---

## 6. Repository abstraction

Replace the current `MemoryStore | PostgresStore` union with interfaces.

Example:

```ts
interface PurchaseOrderRepository {
  getIdentity(entityId: string): Promise<PurchaseOrderIdentity | null>;
  getState(entityId: string): Promise<PurchaseOrderState | null>;
  getTimeline(entityId: string): Promise<Event[]>;
  list(options?: PurchaseOrderListOptions): Promise<PurchaseOrderSummary[]>;
  appendEvents(input: AppendEventsInput): Promise<AppendEventsResult>;
}

interface SourceRepository {
  get(id: string): Promise<SourceRecord | null>;
  createImmutable(record: NewSourceRecord): Promise<SourceRecord>;
}

interface ProposalRepository {
  get(id: string): Promise<ChangeProposal | null>;
  create(proposal: NewChangeProposal): Promise<ChangeProposal>;
  markApplied(...): Promise<void>;
}
```

Benefits:

- routes stop caring about memory vs Postgres;
- testing gets easier;
- DB logic can move into `packages/db`;
- Hono app becomes smaller;
- transactional boundaries become explicit.

Keep the memory adapters for fast tests.

---

## 7. Target data model

### 7.1 Organizations

Add early, even if only one organization exists in development.

```text
organizations
-------------
id uuid/text PK
name
created_at
updated_at
```

### 7.2 Users

Keep role handling simple initially.

```text
users
-----
id
organization_id FK
email
name
role
created_at
updated_at
```

Initial roles:

```text
viewer
buyer
procurement_manager
admin
```

### 7.3 Suppliers

```text
suppliers
---------
id
organization_id
supplier_code
name
primary_email
email_domain
phone
country
currency
default_payment_terms
status
created_at
updated_at

UNIQUE(organization_id, supplier_code)
```

### 7.4 Purchase order identity

Extend the existing table carefully.

```text
purchase_orders
---------------
entity_id
organization_id
po_number
normalized_po_number
supplier_id
created_at

UNIQUE(organization_id, normalized_po_number)
```

Supplier display name should come through `supplier_id` when possible.

### 7.5 Purchase order projection

```text
purchase_order_projection
-------------------------
entity_id PK/FK
organization_id
ordered_quantity
confirmed_quantity
received_quantity
eta
status
revision
last_occurred_at
updated_at
```

This table is derived.

It may be rebuilt from canonical events.

### 7.6 Canonical events

Keep the immutable event concept.

Add tenancy and richer audit metadata over time:

```text
canonical_events
----------------
id
organization_id
idempotency_key
entity_type
entity_id
event_type
occurred_at
ingested_at
source_record_id
payload
schema_version
actor_type
actor_id
```

Possible actor types:

```text
IMPORT
USER
SYSTEM
INTEGRATION
```

Do not label the LLM itself as an actor that changes operational state. The approval/application service is the actor.

### 7.7 Source records

Keep immutable raw evidence.

```text
source_records
--------------
id
organization_id
source_type
source_name
content
content_hash
metadata
imported_at
retention_class
```

### 7.8 Supplier messages

```text
supplier_messages
-----------------
id
organization_id
supplier_id nullable
source_record_id
channel
external_message_id nullable
thread_id nullable
sender
recipients jsonb
subject nullable
sent_at nullable
received_at
processing_status
created_at

UNIQUE(organization_id, channel, external_message_id)
  where external_message_id is not null
```

Processing states:

```text
RECEIVED
MATCHING
ANALYZING
PROPOSAL_CREATED
REVIEW_REQUIRED
PROCESSED
IGNORED
FAILED
```

### 7.9 Message-to-PO candidates

Do not force one PO too early.

```text
message_po_candidates
---------------------
message_id
purchase_order_id
match_method
match_score nullable
is_selected
created_at
```

Match methods:

```text
EXACT_PO_REFERENCE
SUPPLIER_OPEN_PO
USER_SELECTED
MODEL_SUGGESTED
```

For V1, auto-selection should occur only for a deterministic unique match.

### 7.10 Change proposals

```text
change_proposals
----------------
id
organization_id
analysis_run_key
message_id nullable
entity_id
proposal_type
payload jsonb
evidence jsonb
review_state
baseline_revision
status
created_at
reviewed_at nullable
reviewed_by nullable
applied_at nullable
```

Proposal status:

```text
PENDING
APPROVED
EDITED_AND_APPROVED
REJECTED
STALE
APPLIED
```

Review state is separate from proposal status.

### 7.11 Attention workflow state

Derived exceptions remain in code.

Persist only interaction state:

```text
attention_actions
-----------------
id
organization_id
exception_key
entity_id
action
note nullable
user_id nullable
created_at
expires_at nullable
```

Actions:

```text
ACKNOWLEDGE
SNOOZE
RESOLVE
REOPEN
DISMISS
```

### 7.12 Procurement tasks / follow-ups

```text
procurement_tasks
-----------------
id
organization_id
entity_id nullable
supplier_id nullable
task_type
title
due_at
status
assigned_to nullable
source_exception_key nullable
created_at
completed_at nullable
```

Follow-up sending remains an event when actually sent.

---

## 8. Event model evolution

Do not explode event types unnecessarily.

Near-term event additions worth considering:

```text
SUPPLIER_MESSAGE_LINKED
SUPPLIER_QUANTITY_CHANGED
PO_CANCELLED
PO_CLOSED
DELIVERY_CONFIRMED
```

However, not every database action needs to become a PO event.

For example:

- email receipt belongs to supplier-message storage;
- analysis completion belongs to analysis runs;
- proposal rejection belongs to proposal history;
- attention acknowledgement belongs to attention actions.

Canonical PO events should represent facts that change procurement state.

---

## 9. Operational time vs processing time

This needs explicit treatment before inbox ingestion.

Current approval-generated ETA events use approval time and are forced after the current PO history.

Once supplier messages have a reliable `sent_at`, distinguish:

- **source/effective time:** when the supplier stated the change;
- **ingested time:** when ProcureBrain received it;
- **approved time:** when a human accepted it;
- **event effective time:** the timestamp used in the operational event stream.

Recommended rule:

1. persist all timestamps;
2. proposal baseline revision prevents stale approval;
3. when safe, use supplier `sent_at` as event `occurred_at`;
4. keep approval time in event metadata/audit fields;
5. if applying an older message would be superseded by a later event, do not force it to the end of history merely to make it win.

This gives historically correct replay.

---

## 10. Supplier inbox pipeline

This should be the next major capability after DB/domain stabilization.

```text
email/webhook/manual message
          |
          v
immutable source record
          |
          v
supplier_messages row
          |
          v
deterministic supplier match
          |
          v
PO reference extraction / matching
          |
          +--> zero candidate -> review
          |
          +--> many candidates -> review
          |
          v
one deterministic candidate
          |
          v
build operational PO context
          |
          v
LLM structured extraction
          |
          v
validate evidence + fields
          |
          v
change proposal
          |
          v
human approval
          |
          v
canonical event
          |
          v
projection + attention
```

### Matching order

Use deterministic methods before model inference:

1. exact normalized PO number in subject/body;
2. supplier identity from sender;
3. open POs belonging to that supplier;
4. aliases/reference normalization;
5. only then allow AI to suggest candidates.

The model may suggest a candidate but must not silently attach the message when several POs are plausible.

---

## 11. API plan

Keep existing endpoints working while new APIs are introduced.

### 11.1 Health

```http
GET /api/health
```

Add later:

```json
{
  "ok": true,
  "storage": "postgres",
  "db": "ok",
  "worker": "ok",
  "aiConfigured": true
}
```

Do not leak provider secrets or connection details.

### 11.2 Purchase orders

```http
GET    /api/purchase-orders
GET    /api/purchase-orders/:id
GET    /api/purchase-orders/:id/timeline
POST   /api/imports/purchase-orders
```

Add filters:

```text
supplier
status
attention
etaBefore
query
limit
cursor
```

Avoid returning every PO forever.

### 11.3 Suppliers

```http
GET  /api/suppliers
POST /api/suppliers
GET  /api/suppliers/:id
PATCH /api/suppliers/:id
GET  /api/suppliers/:id/purchase-orders
GET  /api/suppliers/:id/performance
```

### 11.4 Messages

```http
POST /api/messages
GET  /api/messages
GET  /api/messages/:id
POST /api/messages/:id/process
POST /api/messages/:id/link-purchase-order
```

The manual POST path should use exactly the same pipeline as future email ingestion.

### 11.5 Proposals

Move toward a first-class proposal API.

```http
GET  /api/proposals
GET  /api/proposals/:id
POST /api/proposals/:id/approve
POST /api/proposals/:id/reject
POST /api/proposals/:id/approve-with-edit
```

The existing analysis-run approval route can remain as compatibility during migration.

### 11.6 Attention

```http
GET  /api/attention
POST /api/attention/:key/acknowledge
POST /api/attention/:key/snooze
POST /api/attention/:key/resolve
```

Response should combine derived exception data with persisted workflow state.

### 11.7 Analysis history

Keep:

```http
GET /api/analysis/runs
GET /api/analysis/runs/:key
```

Restrict raw model request/response payload visibility by role in real deployments.

---

## 12. Proposal execution pattern

Every material AI-derived change should follow one command flow.

Example ETA command:

```ts
ApplyEtaProposal {
  proposalId
  expectedRevision
  eta
  reviewerId
}
```

Handler:

```text
begin transaction
  lock PO
  load proposal
  verify PENDING
  verify organization
  load current projection/history
  compare baseline revision
  validate edited ETA
  verify source/evidence
  verify action allowed
  append canonical event
  update projection
  mark proposal applied
commit
```

The current stale-draft and idempotent-approval behavior is valuable and must survive the refactor.

---

## 13. Purchase-order projection strategy

### Phase A: query only relevant streams

Immediately stop loading all events for individual PO reads.

Add repository queries:

```sql
select ...
from canonical_events
where organization_id = $1
  and entity_id = $2
order by occurred_at, id;
```

### Phase B: transactional projection

When event volume grows, update `purchase_order_projection` whenever events are appended.

Projection logic must reuse the domain reducer or equivalent domain transition code; do not duplicate PO rules in SQL ad hoc.

Add a rebuild command:

```bash
pnpm --filter @procurebrain/api rebuild:po-projections
```

A derived projection must always be recoverable from canonical events.

---

## 14. Attention engine roadmap

Current rules are a good start.

Add rules only when the required facts exist.

### V1 rules

```text
ETA_CHANGED
LATE_PO
QUANTITY_SHORT
RECEIPT_SHORT
FOLLOWUP_OVERDUE
```

### Near-term rules

```text
DELIVERY_DUE_SOON_UNCONFIRMED
SUPPLIER_MESSAGE_UNMATCHED
PROPOSAL_WAITING_TOO_LONG
MULTIPLE_ETA_CHANGES
NO_SUPPLIER_RESPONSE
```

### Later, after inventory/production context exists

```text
STOCKOUT_RISK
PRODUCTION_DATE_AT_RISK
SUPPLIER_DEPENDENCY_RISK
BUDGET_VARIANCE
```

Do not fake these before the system has the required inventory, production, or budget facts.

---

## 15. Quotation comparison module

This is the second large workflow after inbox + PO updates are dependable.

### Tables

```text
rfqs
rfq_lines
quotations
quotation_lines
quotation_terms
```

### Data to extract

```text
supplier
currency
item
quantity
unit price
total
MOQ
lead time
delivery date
payment terms
valid until
incoterm if present
tax/freight if present
exceptions / notes
```

### Rule

AI extracts.

Code normalizes and calculates.

Human chooses.

The model must never be asked "which supplier should we buy from?" and treated as the decision engine.

Comparison output should make trade-offs explicit rather than invent a winner.

---

## 16. Follow-up automation

The system can remove repetitive chasing without becoming an autonomous negotiator.

Flow:

```text
attention rule / task due
        |
        v
draft deterministic or AI-assisted message
        |
        v
human review
        |
        v
send through channel adapter
        |
        v
FOLLOWUP_SENT event
        |
        v
schedule response deadline
```

Store outbound message ID so a reply can be linked to the same thread.

Do not auto-send supplier commitments in the first production version.

---

## 17. Supplier performance

Start with calculated facts, not AI scoring.

Metrics:

```text
total POs
completed POs
on-time delivery rate
average days late
ETA change count
quantity shortfall count
receipt discrepancy count
open issues
average response time
```

Every metric should have a documented formula.

Avoid a single opaque "supplier score" until users prove they need one.

---

## 18. Background jobs

Do not introduce Kafka, Temporal, or a distributed workflow engine yet.

A PostgreSQL-backed job table is enough.

```text
jobs
----
id
organization_id
type
payload
status
attempts
available_at
locked_at
locked_by
last_error
created_at
completed_at
```

Initial job types:

```text
PROCESS_SUPPLIER_MESSAGE
SYNC_EMAIL
REBUILD_PO_PROJECTION
RECALCULATE_SUPPLIER_METRICS
```

A worker can live in the same repository:

```bash
pnpm --filter @procurebrain/api worker
```

Use bounded concurrency and idempotent handlers.

---

## 19. Email integration design

Build one channel only.

Provider-specific logic belongs behind an adapter:

```ts
interface MailConnector {
  sync(cursor?: string): Promise<MailSyncResult>;
  getMessage(externalId: string): Promise<ExternalMessage>;
  createDraft(input: DraftInput): Promise<ExternalDraft>;
  sendDraft?(draftId: string): Promise<SendResult>;
}
```

Normalise all channel messages into the same `supplier_messages` table.

Required properties for idempotency:

```text
organization
channel
provider account
external message ID
```

Do not make email-specific fields leak into core PO logic.

---

## 20. AI extraction v2

### Input

The model should receive only relevant facts:

```text
selected/candidate PO
supplier
current ETA
current quantities
recent relevant PO events
supplier message
```

Do not send 50 unrelated PO context rows by default.

### Output

Move from a flat commitment toward a typed observation, while keeping strict schemas.

Example:

```json
{
  "poReference": "PO-1001",
  "observations": [
    {
      "kind": "ETA_CHANGE",
      "value": "2026-10-18",
      "evidence": "revised delivery date is October 18"
    }
  ],
  "ambiguities": []
}
```

The application then decides whether a supported proposal can be created.

This prevents one AI output schema from becoming the business policy engine.

### Evidence verification

Current Zod validation proves shape, not truth.

Add deterministic evidence checks where possible:

- evidence string appears in normalized source text;
- extracted PO reference appears in source or is explicitly provided as baseline context;
- extracted date is either present verbatim or resolved by a separately tested date parser;
- unsupported inferred values force review.

---

## 21. Analysis cache rules

The current versioned cache is one of the stronger parts of the project.

Keep cache identity dependent on:

- exact input;
- relevant PO baseline context;
- provider;
- model;
- prompt version;
- schema version;
- interpretation-affecting options.

Never let a cached result bypass a fresh **approval baseline check**.

Cached interpretation can be reused. Operational validity must be checked at application time.

---

## 22. Security and tenancy

Before real business data:

### Required

- authentication;
- organization membership;
- tenant filter on every repository query;
- organization ID on source, event, message, analysis, proposal, attention, supplier, RFQ records;
- secrets outside Git;
- TLS;
- managed Postgres encryption at rest;
- no supplier message bodies in general request logs;
- role checks on raw analysis evidence;
- audit log for approvals and sends;
- backup + restore test;
- retention policy.

### Recommended database constraints

Prefer composite uniqueness such as:

```text
(organization_id, normalized_po_number)
(organization_id, supplier_code)
(organization_id, channel, external_message_id)
```

Do not rely only on application code for cross-tenant uniqueness.

---

## 23. Observability

Add structured logging with a request/correlation ID.

Useful identifiers:

```text
requestId
organizationId
sourceRecordId
messageId
analysisRunKey
proposalId
entityId
eventId
jobId
```

Metrics:

```text
message processing latency
AI provider latency
AI error rate
token/cost
proposal creation rate
proposal approval rate
proposal edit rate
proposal rejection rate
stale proposal rate
PO match rate
unmatched message rate
open attention count
follow-up overdue count
```

Never log secrets or full supplier text by default.

---

## 24. Testing strategy

### 24.1 Domain tests

Pure tests for:

- event ordering;
- reducer state;
- exception rules;
- proposal-to-event commands;
- effective-time behavior;
- projection rebuild equivalence.

### 24.2 Repository tests

Against isolated PostgreSQL schema:

- organization isolation;
- unique PO number per organization;
- event append transaction;
- concurrent approval;
- source immutability;
- proposal transition guards;
- message idempotency;
- projection consistency.

### 24.3 API tests

Verify:

- malformed payload rejection;
- auth/tenant boundaries;
- cursor pagination;
- 404/409 behavior;
- stale proposal;
- idempotent retry;
- unmatched/ambiguous PO cases;
- attention actions.

### 24.4 AI contract tests

Mock provider response for:

- correct schema;
- malformed JSON;
- unsupported dates;
- missing evidence;
- conflicting PO reference;
- provider failure;
- low confidence;
- prompt injection text.

### 24.5 Evaluation

Create a new representative dataset.

Minimum categories:

```text
clear ETA change
clear quantity change
confirmation/no change
multiple POs in one email
no PO reference
wrong supplier/PO
forwarded thread
conflicting dates
relative date
attachment-only facts
irrelevant email
duplicate email
cancelled order
ambiguous wording
```

Group splits by scenario/supplier/thread so near-duplicates do not leak across train/tuning/final evaluation sets.

---

## 25. Migration plan from the current database

Do not replace existing tables in one migration.

Suggested sequence:

### 0003_organizations_suppliers.sql

Add:

```text
organizations
users
suppliers
```

Add `organization_id` nullable initially to existing tables.

Backfill one development organization.

Then make tenant columns non-null.

### 0004_purchase_order_identity.sql

Add:

```text
organization_id
normalized_po_number
supplier_id FK
created_at
```

Add organization-scoped uniqueness.

### 0005_supplier_messages.sql

Add:

```text
supplier_messages
message_po_candidates
```

### 0006_change_proposals.sql

Create first-class proposals.

Existing analysis-run ETA approval remains temporarily supported.

### 0007_po_projection.sql

Add materialized PO projection and rebuild script.

### 0008_attention_actions.sql

Add persisted user workflow state without replacing derived exceptions.

### 0009_jobs.sql

Only when inbox/background processing needs it.

Run every migration against:

1. empty database;
2. database containing current prototype data;
3. second execution to confirm idempotent startup assumptions if startup still applies migrations.

Longer term, switch from "application applies every migration on startup" to a deliberate deployment migration step.

---

## 26. API implementation order

### Phase 0 — protect current behavior

Before feature work:

- keep all current tests green;
- create repository interfaces;
- move Postgres queries behind repositories;
- change per-PO reads to query only that PO's events;
- preserve current approval concurrency/idempotency behavior.

**Exit condition:** no behavior regression.

### Phase 1 — durable procurement model

Implement:

- organizations;
- suppliers;
- tenant-aware PO identity;
- PO projection;
- pagination;
- source/event tenant boundaries.

**Exit condition:** create/import/list/read POs and suppliers fully through PostgreSQL with no all-event scan for individual PO reads.

### Phase 2 — supplier message API

Implement:

- manual `POST /api/messages`;
- supplier message table;
- deterministic supplier matching;
- exact PO reference matching;
- first-class message processing state;
- automatic operational PO context builder.

**Exit condition:** API can accept a raw supplier message without a user first selecting the PO, uniquely match a clear reference, and produce a proposal or explicit review case.

### Phase 3 — generic proposal lifecycle

Implement first-class proposal persistence and endpoints.

Support only:

- ETA change first;
- quantity change second.

**Exit condition:** proposal -> approve/edit/reject -> canonical event is transactional, idempotent, stale-safe, and auditable.

### Phase 4 — attention API

Implement:

- derived attention list;
- stable exception key;
- acknowledge/snooze/resolve state;
- filters.

**Exit condition:** `GET /api/attention` answers "what needs me today?" without UI-specific logic.

### Phase 5 — one email connector

Implement one real mailbox integration.

**Exit condition:** new supplier email can flow to `supplier_messages` idempotently and trigger the same processing pipeline as manual message ingestion.

### Phase 6 — quotation comparison

Only after message/PO update flow is dependable.

**Exit condition:** upload/ingest quotations -> normalized terms/lines -> deterministic comparison table.

### Phase 7 — follow-up drafts

Only after attention workflow is used.

**Exit condition:** due follow-up -> draft -> human approval -> send -> response linkage.

---

## 27. Minimal UI boundary

Do not rebuild the UI while the API/domain is unstable.

Once Phases 1-4 work via tests/curl/Postman, the first UI needs only four areas:

```text
1. Attention
2. Inbox
3. Purchase Orders
4. Suppliers
```

The home screen should answer one question:

> **What requires my attention today?**

No analytics dashboard is required for V1.

---

## 28. What should not be built yet

Explicitly defer:

- multi-agent architecture;
- vector database/RAG platform;
- autonomous negotiation;
- autonomous supplier selection;
- automatic financial commitments;
- demand forecasting;
- inventory optimization;
- S&OP suite;
- ERP replacement;
- advanced supplier risk ML;
- mobile app;
- complex permissions;
- microservices;
- event bus;
- Kafka;
- Temporal;
- Kubernetes.

Any of those can be revisited after the supplier-message -> proposal -> approval -> attention loop is used by real procurement users.

---

## 29. Definition of V1

V1 is complete when this works reliably:

```text
1. Import/create purchase orders in PostgreSQL.
2. Store suppliers.
3. Receive a supplier message through the message API.
4. Identify supplier.
5. Match an explicit PO reference automatically.
6. Load the actual current PO baseline.
7. Extract an ETA or quantity change with evidence.
8. Produce a persisted review proposal.
9. Allow approve / edit / reject.
10. Reject stale proposals.
11. Apply approved change as an immutable canonical event.
12. Update/rebuild current PO projection.
13. Recalculate deterministic attention.
14. Show a complete audit trail.
15. Survive restart.
16. Enforce organization isolation.
```

The product is not V1 merely because the model can parse a supplier email.

---

## 30. Product/evaluation metrics for V1

Track:

```text
PO exact-match rate
supplier match rate
ETA extraction accuracy
quantity extraction accuracy
evidence-support rate
unmatched-message rate
ambiguous-message rate
proposal approval-without-edit rate
proposal edit rate
proposal rejection rate
stale proposal rate
unsafe-accept rate
time from message received -> proposal
time from proposal -> decision
important changes surfaced
false attention rate
```

Later business metrics:

```text
manual supplier checks avoided
follow-ups avoided
late changes caught earlier
orders managed per procurement person
time spent reviewing procurement inbox
```

---

## 31. File-by-file implementation map

### `packages/domain/src/events.ts`

Keep canonical envelope. Add event types only when they represent operational facts. Plan schema versioning before changing payload shapes.

### `packages/domain/src/reducer.ts`

Keep pure. Add tests before every new state field. Projection rebuild must use this logic.

### `packages/domain/src/exceptions.ts`

Keep deterministic. Expand only from stored facts. Separate risk existence from user acknowledgement state.

### `apps/api/src/store.ts`

This is the biggest refactor target.

Move toward repository interfaces and `packages/db` implementations. Stop using `allEvents()` for per-entity queries. Preserve transaction locks and stale revision checks.

### `packages/db/src/schema.ts`

Expand schema for organizations, suppliers, messages, proposals, projection, attention actions, and later quotations/jobs.

### `apps/api/src/app.ts`

Current file owns too much orchestration. Keep Hono, but route handlers should call application services. Extract message/proposal/attention routes incrementally.

### `packages/ai/src/adapter.ts`

Keep "proposal only, never writes event" rule. Evolve toward typed observations and evidence checks.

### `packages/ai/src/openrouter.ts`

Keep strict structured output and untrusted-message instruction boundary. Make prompt versions explicit and evaluate each prompt change.

### `packages/analysis-cache`

Keep. This is useful infrastructure. Ensure tenant identity and relevant operational context are included where needed.

### `apps/web/src/main.tsx`

Do not invest heavily yet. Once API shape stabilizes, split into simple pages/components. Current prototype is enough for backend validation.

---

## 32. Critical invariants

These rules should be treated as architecture tests.

1. **AI never directly writes canonical procurement state.**
2. **Every material state change has source provenance.**
3. **Source evidence is immutable by identifier.**
4. **Repeated processing is idempotent.**
5. **Approval checks the current aggregate revision.**
6. **Concurrent divergent approvals cannot both win.**
7. **Derived projections can be rebuilt from canonical events.**
8. **Attention rules are deterministic when based on known facts.**
9. **A model failure cannot corrupt PO state.**
10. **Cross-organization access is impossible at repository boundaries.**
11. **Cached AI interpretation cannot bypass fresh operational validation.**
12. **Unsupported/ambiguous actions become review, not guesses.**

---

## 33. Immediate engineering backlog

Work in this order.

### 1. Introduce repository interfaces

No product behavior change.

### 2. Fix per-PO PostgreSQL reads

Remove full event scans from `state(id)` and `timeline(id)`.

### 3. Add organizations + suppliers migration

Prepare tenancy before real inbox data.

### 4. Add organization-scoped PO identity

Add normalized unique PO reference.

### 5. Add PO projection

Create rebuild test proving event replay == stored projection.

### 6. Add `supplier_messages`

Manual ingestion endpoint first.

### 7. Add deterministic message -> PO matching

Exact normalized reference first. No model required.

### 8. Build PO model-context service

Use real current PO data, not manually supplied corpus context.

### 9. Add persisted `change_proposals`

Migrate ETA review onto it while keeping compatibility.

### 10. Add `GET /api/attention` + attention actions

Then and only then build the minimal four-screen UI.

---

## 34. First technical milestone

The next milestone should be completely testable without UI.

```bash
# create/import a supplier + PO
POST /api/suppliers
POST /api/imports/purchase-orders

# ingest message
POST /api/messages

# process it
POST /api/messages/:id/process

# inspect proposal
GET /api/proposals/:id

# approve
POST /api/proposals/:id/approve

# inspect new state
GET /api/purchase-orders/:id
GET /api/purchase-orders/:id/timeline

# inspect exception
GET /api/attention
```

Acceptance scenario:

> PO-1001 currently has ETA 2026-10-08. A supplier message says "For PO-1001, revised delivery is October 12, 2026." The system deterministically matches PO-1001, uses the current ETA as context, extracts October 12 with evidence, creates a pending ETA proposal, applies it only after approval, appends a source-linked event, updates the PO projection, and emits an ETA-change attention item.

If this path is dependable, ProcureBrain has a real operational core.

---

## 35. Final recommendation

Do not rewrite the project.

The current code already contains the right difficult ideas:

- immutable evidence;
- event-sourced operational history;
- deterministic replay;
- deterministic exception rules;
- strict AI schemas;
- proposal-before-commit;
- stale-write protection;
- idempotency;
- transaction locking;
- analysis replay.

The next step is to turn those prototype mechanisms into a real procurement domain:

```text
organization
-> suppliers
-> purchase orders
-> supplier messages
-> deterministic matching
-> AI observations
-> typed proposals
-> human approval
-> canonical events
-> projection
-> attention
```

That is the architecture to optimize.

Everything else is secondary until this loop is proven with real procurement users.
