import type { Pool } from "pg";

export async function applyPostgresMigrations(pool: Pool): Promise<void> {
  await pool.query(INITIAL_MIGRATION_SQL);
  await pool.query(WORKER_MIGRATION_SQL);
}

export const INITIAL_MIGRATION_SQL = `
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
`;

export const WORKER_MIGRATION_SQL = `
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
`;
