import { Pool, type PoolConfig } from "pg";
import { applyPostgresMigrations } from "./postgres-migrations.js";
import { decodeStoredValue, encodeStoredValue } from "./serialization.js";
import type { IdempotentLookup, StateStore } from "./state-store.js";
import type { WorkflowResult } from "./types.js";

export interface PostgresStateStoreOptions {
  pool?: Pool;
  connectionString?: string;
  poolConfig?: Omit<PoolConfig, "connectionString">;
}

export class PostgresStateStore implements StateStore {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresStateStoreOptions = {}) {
    if (options.pool && (options.connectionString || options.poolConfig)) {
      throw new TypeError("Pass either an existing pool or connection options, not both");
    }

    this.#ownsPool = options.pool === undefined;
    this.#pool =
      options.pool ??
      new Pool({
        ...options.poolConfig,
        ...(options.connectionString ? { connectionString: options.connectionString } : {}),
      });
  }

  async migrate(): Promise<void> {
    await applyPostgresMigrations(this.#pool);
  }

  async getIdempotentResult(key: string): Promise<IdempotentLookup> {
    const query = await this.#pool.query<{ payload: unknown }>(
      "SELECT payload FROM flowforge.idempotency_results WHERE idempotency_key = $1",
      [key],
    );
    const row = query.rows[0];
    if (!row) return { found: false };
    return { found: true, value: decodeStoredValue(row.payload) };
  }

  async setIdempotentResult(key: string, value: unknown): Promise<void> {
    const payload = JSON.stringify(encodeStoredValue(value));
    await this.#pool.query(
      `INSERT INTO flowforge.idempotency_results (idempotency_key, payload)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (idempotency_key) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [key, payload],
    );
  }

  async saveRun(result: WorkflowResult): Promise<void> {
    const payload = JSON.stringify(encodeStoredValue(result));
    await this.#pool.query(
      `INSERT INTO flowforge.runs
         (run_id, workflow_id, status, started_at, completed_at, payload)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::jsonb)
       ON CONFLICT (run_id) DO UPDATE
       SET workflow_id = EXCLUDED.workflow_id,
           status = EXCLUDED.status,
           started_at = EXCLUDED.started_at,
           completed_at = EXCLUDED.completed_at,
           payload = EXCLUDED.payload,
           updated_at = NOW()`,
      [result.runId, result.workflowId, result.status, result.startedAt, result.completedAt, payload],
    );
  }

  async getRun(runId: string): Promise<WorkflowResult | undefined> {
    const query = await this.#pool.query<{ payload: unknown }>("SELECT payload FROM flowforge.runs WHERE run_id = $1", [
      runId,
    ]);
    const row = query.rows[0];
    if (!row) return undefined;

    const decoded = decodeStoredValue(row.payload);
    if (!isWorkflowResult(decoded)) {
      throw new TypeError(`Stored FlowForge run "${runId}" is malformed`);
    }
    return decoded;
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}

function isWorkflowResult(value: unknown): value is WorkflowResult {
  if (!isRecord(value)) return false;
  return (
    typeof value.workflowId === "string" &&
    typeof value.runId === "string" &&
    (value.status === "completed" || value.status === "failed") &&
    typeof value.startedAt === "string" &&
    typeof value.completedAt === "string" &&
    isRecord(value.steps) &&
    isRecord(value.context)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
