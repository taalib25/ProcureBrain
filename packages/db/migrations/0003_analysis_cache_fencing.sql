ALTER TABLE analysis_runs
  ADD COLUMN IF NOT EXISTS owner_token text,
  ADD COLUMN IF NOT EXISTS lease_generation integer NOT NULL DEFAULT 0;
