-- 0003: tenancy foundation (plan 7.1-7.4). Idempotent: safe to reapply at startup.
create table if not exists organizations (
  id text primary key, name text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
insert into organizations(id, name) values ('org-dev', 'Development organization')
on conflict(id) do nothing;

create table if not exists users (
  id text primary key, organization_id text not null references organizations(id),
  email text not null, name text, role text not null default 'viewer',
  created_at timestamptz not null default now()
);

create table if not exists suppliers (
  id text primary key, organization_id text not null references organizations(id),
  supplier_code text not null, name text not null,
  primary_email text, email_domain text, phone text, country text, currency text,
  default_payment_terms text, status text not null default 'active',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(organization_id, supplier_code)
);

-- Tenant columns on existing tables. Nullable for backfill, then enforced by
-- application writes (every writer below stamps organization_id).
alter table purchase_orders add column if not exists organization_id text references organizations(id);
alter table purchase_orders add column if not exists normalized_po_number text;
alter table canonical_events add column if not exists organization_id text references organizations(id);
alter table source_records add column if not exists organization_id text references organizations(id);

-- Backfill the single development org plus normalized references (mirrors the
-- ingestion normalizePoReference rule: trim, uppercase, strip non-alphanumerics).
update purchase_orders set organization_id = 'org-dev' where organization_id is null;
update purchase_orders set normalized_po_number = upper(regexp_replace(po_number, '[^A-Z0-9]', '', 'g')) where normalized_po_number is null;
update canonical_events set organization_id = 'org-dev' where organization_id is null;
update source_records set organization_id = 'org-dev' where organization_id is null;

create unique index if not exists purchase_orders_org_po_unique on purchase_orders(organization_id, normalized_po_number);
create index if not exists purchase_orders_org on purchase_orders(organization_id);
create index if not exists canonical_events_org on canonical_events(organization_id);
create index if not exists suppliers_org on suppliers(organization_id);
