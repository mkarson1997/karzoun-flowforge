CREATE TABLE IF NOT EXISTS flowforge.workers (
  worker_id text PRIMARY KEY,
  metadata jsonb NOT NULL,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  heartbeat_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flowforge.work_items (
  work_id text PRIMARY KEY,
  workflow_id text NOT NULL,
  run_id text NOT NULL,
  step_id text NOT NULL,
  task_type text NOT NULL,
  payload jsonb NOT NULL,
  result_payload jsonb,
  status text NOT NULL CHECK (status IN ('queued', 'leased', 'completed', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  available_at timestamptz NOT NULL DEFAULT NOW(),
  lease_owner text REFERENCES flowforge.workers(worker_id) ON DELETE SET NULL,
  lease_expires_at timestamptz,
  last_error text,
  completed_at timestamptz,
  dead_lettered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (run_id, step_id)
);

CREATE INDEX IF NOT EXISTS work_items_claim_idx
  ON flowforge.work_items (status, available_at, created_at);

CREATE INDEX IF NOT EXISTS work_items_lease_expiry_idx
  ON flowforge.work_items (lease_expires_at)
  WHERE status = 'leased';

INSERT INTO flowforge.schema_migrations (version)
VALUES (2)
ON CONFLICT (version) DO NOTHING;
