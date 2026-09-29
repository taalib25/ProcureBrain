CREATE TABLE IF NOT EXISTS analysis_inputs (
  hash text PRIMARY KEY,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  cache_key text PRIMARY KEY,
  id text NOT NULL,
  input_hash text NOT NULL REFERENCES analysis_inputs(hash),
  request jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','failed','needs_review')),
  result jsonb,
  error text,
  model_request jsonb,
  model_response jsonb,
  usage jsonb,
  fallback_tier text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz,
  lease_until timestamptz
);

CREATE INDEX IF NOT EXISTS analysis_runs_status_lease_idx ON analysis_runs(status, lease_until);
