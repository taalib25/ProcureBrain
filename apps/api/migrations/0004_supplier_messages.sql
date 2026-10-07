-- 0004: durable supplier messages (plan 7.8-7.9). Numbered 0004 because PO
-- identity (plan 0004) was folded into 0003. Idempotent: safe to reapply.
create table if not exists supplier_messages (
  id text primary key,
  organization_id text not null references organizations(id),
  supplier_id text references suppliers(id),
  source_record_id text not null references source_records(id),
  channel text not null,
  external_message_id text,
  thread_id text,
  sender text,
  recipients jsonb,
  subject text,
  text_content text not null,
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  processing_status text not null default 'RECEIVED',
  proposal_run_key text,
  created_at timestamptz not null default now(),
  unique(organization_id, channel, external_message_id)
);

create table if not exists message_po_candidates (
  message_id text not null references supplier_messages(id),
  entity_id text not null,
  match_method text not null,
  match_score double precision,
  is_selected boolean not null default false,
  created_at timestamptz not null default now(),
  primary key(message_id, entity_id)
);

create index if not exists supplier_messages_org_status on supplier_messages(organization_id, processing_status);
create index if not exists supplier_messages_source on supplier_messages(source_record_id);
