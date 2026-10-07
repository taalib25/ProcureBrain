-- Connector checkpoints contain no access tokens. Credentials stay on the server.
create table if not exists connector_state (
  organization_id text not null references organizations(id),
  connector_id text not null,
  state jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (organization_id, connector_id)
);
create index if not exists supplier_messages_org_thread on supplier_messages(organization_id, thread_id, sent_at);
create index if not exists supplier_messages_org_supplier on supplier_messages(organization_id, supplier_id, sent_at);
