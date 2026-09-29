create table if not exists source_records (
  id text primary key, source_type text not null, source_name text, content text not null,
  metadata jsonb, imported_at timestamptz not null
);
create table if not exists canonical_events (
  id text primary key, idempotency_key text not null unique, entity_type text not null,
  entity_id text not null, event_type text not null, occurred_at timestamptz not null,
  ingested_at timestamptz not null, source_record_id text not null references source_records(id),
  payload jsonb not null, schema_version integer not null
);
create table if not exists purchase_orders (
  entity_id text primary key, po_number text not null, supplier_id text, supplier_name text
);
create table if not exists analysis_inputs (
  hash text primary key, content bytea not null, created_at timestamptz not null default now()
);
create table if not exists analysis_runs (
  cache_key text primary key, id text not null, input_hash text not null references analysis_inputs(hash),
  request jsonb not null, status text not null, result jsonb, error text, model_request jsonb,
  model_response jsonb, usage jsonb, fallback_tier text, created_at timestamptz not null,
  completed_at timestamptz, lease_until timestamptz
);
create index if not exists canonical_events_entity_time on canonical_events(entity_id, occurred_at);
create index if not exists analysis_runs_created on analysis_runs(created_at desc);
