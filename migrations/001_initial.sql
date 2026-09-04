CREATE SCHEMA IF NOT EXISTS flowforge;

CREATE TABLE IF NOT EXISTS flowforge.schema_migrations (
  version integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flowforge.runs (
  run_id text PRIMARY KEY,
  workflow_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('completed', 'failed')),
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS runs_workflow_started_idx
  ON flowforge.runs (workflow_id, started_at DESC);

CREATE TABLE IF NOT EXISTS flowforge.idempotency_results (
  idempotency_key text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO flowforge.schema_migrations (version)
VALUES (1)
ON CONFLICT (version) DO NOTHING;
