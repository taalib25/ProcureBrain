alter table analysis_runs
  add column if not exists owner_token text,
  add column if not exists lease_generation integer not null default 0;
