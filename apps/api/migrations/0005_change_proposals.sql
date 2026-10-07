-- 0005: first-class change proposals (plan 7.10). Numbered 0005 in actual
-- sequence; plan section 25 calls this step 0006. Idempotent.
create table if not exists change_proposals (
  id text primary key,
  organization_id text not null references organizations(id),
  analysis_run_key text not null,
  message_id text references supplier_messages(id),
  entity_id text not null,
  proposal_type text not null,
  payload jsonb not null,
  evidence jsonb not null,
  review_state text not null,
  baseline_revision text not null,
  status text not null default 'PENDING',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  reviewed_note text,
  applied_at timestamptz,
  unique(organization_id, analysis_run_key)
);

create index if not exists change_proposals_org_status on change_proposals(organization_id, status);
create index if not exists change_proposals_entity on change_proposals(entity_id);
