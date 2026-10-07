CREATE TABLE IF NOT EXISTS agent_work (
 id text PRIMARY KEY,
 organization_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('message', 'email')),
 dedupe_key text NOT NULL,
 status text NOT NULL,
 payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz,
 lease_token text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(organization_id, kind, dedupe_key)
);
CREATE INDEX IF NOT EXISTS agent_work_ready ON agent_work(kind, status, available_at);
