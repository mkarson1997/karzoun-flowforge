import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type PoolConfig } from "pg";
import { applyPostgresMigrations } from "./postgres-migrations.js";
import { decodeStoredValue, encodeStoredValue } from "./serialization.js";

export type WorkItemStatus = "queued" | "leased" | "completed" | "dead_letter";

export interface EnqueueWorkItemInput {
  id?: string;
  workflowId: string;
  runId: string;
  stepId: string;
  taskType: string;
  payload?: unknown;
  maxAttempts?: number;
}

export interface WorkItem {
  id: string;
  workflowId: string;
  runId: string;
  stepId: string;
  taskType: string;
  payload: unknown;
  status: WorkItemStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  result?: unknown;
  lastError?: string;
  completedAt?: string;
  deadLetteredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedWorkItem extends WorkItem {
  status: "leased";
  leaseOwner: string;
  leaseExpiresAt: string;
}

export interface PostgresWorkQueueOptions {
  pool?: Pool;
  connectionString?: string;
  poolConfig?: Omit<PoolConfig, "connectionString">;
}

export class PostgresWorkQueue {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;

  constructor(options: PostgresWorkQueueOptions = {}) {
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

  async registerWorker(workerId: string, metadata: unknown = {}): Promise<void> {
    assertNonEmpty(workerId, "workerId");
    const payload = JSON.stringify(encodeStoredValue(metadata));
    await this.#pool.query(
      `INSERT INTO flowforge.workers (worker_id, metadata)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (worker_id) DO UPDATE
       SET metadata = EXCLUDED.metadata, heartbeat_at = NOW()`,
      [workerId, payload],
    );
  }

  async heartbeatWorker(workerId: string): Promise<boolean> {
    const result = await this.#pool.query(
      "UPDATE flowforge.workers SET heartbeat_at = NOW() WHERE worker_id = $1",
      [workerId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async enqueue(input: EnqueueWorkItemInput): Promise<WorkItem> {
    assertNonEmpty(input.workflowId, "workflowId");
    assertNonEmpty(input.runId, "runId");
    assertNonEmpty(input.stepId, "stepId");
    assertNonEmpty(input.taskType, "taskType");

    const id = input.id ?? randomUUID();
    const maxAttempts = finiteIntegerAtLeastOne(input.maxAttempts, 3);
    const payload = JSON.stringify(encodeStoredValue(input.payload));
    const query = await this.#pool.query<DbWorkItemRow>(
      `INSERT INTO flowforge.work_items
         (work_id, workflow_id, run_id, step_id, task_type, payload, status, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'queued', $7)
       ON CONFLICT (run_id, step_id) DO UPDATE
       SET work_id = flowforge.work_items.work_id
       RETURNING ${WORK_ITEM_COLUMNS}`,
      [id, input.workflowId, input.runId, input.stepId, input.taskType, payload, maxAttempts],
    );
    return rowToWorkItem(requireRow(query.rows[0]));
  }

  async claimNext(workerId: string, leaseMs = 30_000): Promise<ClaimedWorkItem | undefined> {
    assertNonEmpty(workerId, "workerId");
    const leaseDuration = finitePositive(leaseMs, 30_000);
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");
      await deadLetterExpiredFinalAttempts(client);
      const query = await client.query<DbWorkItemRow>(
        `WITH candidate AS (
           SELECT work_id
           FROM flowforge.work_items
           WHERE (
             status = 'queued' AND available_at <= NOW()
           ) OR (
             status = 'leased' AND lease_expires_at <= NOW() AND attempts < max_attempts
           )
           ORDER BY available_at ASC, created_at ASC, work_id ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE flowforge.work_items AS item
         SET status = 'leased',
             attempts = item.attempts + 1,
             lease_owner = $1,
             lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
             last_error = CASE
               WHEN item.status = 'leased' THEN COALESCE(item.last_error, 'lease expired; work reclaimed')
               ELSE item.last_error
             END,
             updated_at = NOW()
         FROM candidate
         WHERE item.work_id = candidate.work_id
         RETURNING ${qualifiedColumns("item")}`,
        [workerId, leaseDuration],
      );
      await client.query("COMMIT");

      const row = query.rows[0];
      if (!row) return undefined;
      const item = rowToWorkItem(row);
      if (item.status !== "leased" || !item.leaseOwner || !item.leaseExpiresAt) {
        throw new Error("Invariant violation: claimed work item is not leased");
      }
      return { ...item, status: "leased", leaseOwner: item.leaseOwner, leaseExpiresAt: item.leaseExpiresAt };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async heartbeatLease(workId: string, workerId: string, leaseMs = 30_000): Promise<boolean> {
    const leaseDuration = finitePositive(leaseMs, 30_000);
    const result = await this.#pool.query(
      `UPDATE flowforge.work_items
       SET lease_expires_at = NOW() + ($3 * INTERVAL '1 millisecond'), updated_at = NOW()
       WHERE work_id = $1
         AND lease_owner = $2
         AND status = 'leased'
         AND lease_expires_at > NOW()`,
      [workId, workerId, leaseDuration],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async complete(workId: string, workerId: string, resultValue: unknown): Promise<boolean> {
    const resultPayload = JSON.stringify(encodeStoredValue(resultValue));
    const result = await this.#pool.query(
      `UPDATE flowforge.work_items
       SET status = 'completed',
           result_payload = $3::jsonb,
           lease_owner = NULL,
           lease_expires_at = NULL,
           completed_at = NOW(),
           updated_at = NOW()
       WHERE work_id = $1
         AND lease_owner = $2
         AND status = 'leased'
         AND lease_expires_at > NOW()`,
      [workId, workerId, resultPayload],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async fail(workId: string, workerId: string, error: unknown, retryDelayMs = 0): Promise<WorkItemStatus | undefined> {
    const delay = finiteNonNegative(retryDelayMs, 0);
    const message = errorMessage(error);
    const query = await this.#pool.query<{ status: WorkItemStatus }>(
      `UPDATE flowforge.work_items
       SET status = CASE WHEN attempts >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
           available_at = CASE
             WHEN attempts >= max_attempts THEN available_at
             ELSE NOW() + ($4 * INTERVAL '1 millisecond')
           END,
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = $3,
           dead_lettered_at = CASE WHEN attempts >= max_attempts THEN NOW() ELSE dead_lettered_at END,
           updated_at = NOW()
       WHERE work_id = $1
         AND lease_owner = $2
         AND status = 'leased'
         AND lease_expires_at > NOW()
       RETURNING status`,
      [workId, workerId, message, delay],
    );
    return query.rows[0]?.status;
  }

  async deadLetter(workId: string, workerId: string, error: unknown): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE flowforge.work_items
       SET status = 'dead_letter',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = $3,
           dead_lettered_at = NOW(),
           updated_at = NOW()
       WHERE work_id = $1
         AND lease_owner = $2
         AND status = 'leased'
         AND lease_expires_at > NOW()`,
      [workId, workerId, errorMessage(error)],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async reapExpiredFinalAttempts(): Promise<number> {
    const result = await this.#pool.query(
      `UPDATE flowforge.work_items
       SET status = 'dead_letter',
           lease_owner = NULL,
           lease_expires_at = NULL,
           last_error = COALESCE(last_error, 'lease expired after final attempt'),
           dead_lettered_at = NOW(),
           updated_at = NOW()
       WHERE status = 'leased'
         AND lease_expires_at <= NOW()
         AND attempts >= max_attempts`,
    );
    return result.rowCount ?? 0;
  }

  async get(workId: string): Promise<WorkItem | undefined> {
    const query = await this.#pool.query<DbWorkItemRow>(
      `SELECT ${WORK_ITEM_COLUMNS} FROM flowforge.work_items WHERE work_id = $1`,
      [workId],
    );
    const row = query.rows[0];
    return row ? rowToWorkItem(row) : undefined;
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }
}

async function deadLetterExpiredFinalAttempts(client: PoolClient): Promise<void> {
  await client.query(
    `UPDATE flowforge.work_items
     SET status = 'dead_letter',
         lease_owner = NULL,
         lease_expires_at = NULL,
         last_error = COALESCE(last_error, 'lease expired after final attempt'),
         dead_lettered_at = NOW(),
         updated_at = NOW()
     WHERE status = 'leased'
       AND lease_expires_at <= NOW()
       AND attempts >= max_attempts`,
  );
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}

const WORK_ITEM_COLUMNS = [
  "work_id",
  "workflow_id",
  "run_id",
  "step_id",
  "task_type",
  "payload",
  "result_payload",
  "status",
  "attempts",
  "max_attempts",
  "available_at",
  "lease_owner",
  "lease_expires_at",
  "last_error",
  "completed_at",
  "dead_lettered_at",
  "created_at",
  "updated_at",
].join(", ");

function qualifiedColumns(alias: string): string {
  return WORK_ITEM_COLUMNS.split(", ")
    .map((column) => `${alias}.${column}`)
    .join(", ");
}

interface DbWorkItemRow {
  work_id: string;
  workflow_id: string;
  run_id: string;
  step_id: string;
  task_type: string;
  payload: unknown;
  result_payload: unknown | null;
  status: WorkItemStatus;
  attempts: number;
  max_attempts: number;
  available_at: Date | string;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  last_error: string | null;
  completed_at: Date | string | null;
  dead_lettered_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

function rowToWorkItem(row: DbWorkItemRow): WorkItem {
  return {
    id: row.work_id,
    workflowId: row.workflow_id,
    runId: row.run_id,
    stepId: row.step_id,
    taskType: row.task_type,
    payload: decodeStoredValue(row.payload),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: toIso(row.available_at),
    ...(row.lease_owner ? { leaseOwner: row.lease_owner } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: toIso(row.lease_expires_at) } : {}),
    ...(row.result_payload !== null ? { result: decodeStoredValue(row.result_payload) } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.completed_at ? { completedAt: toIso(row.completed_at) } : {}),
    ...(row.dead_lettered_at ? { deadLetteredAt: toIso(row.dead_lettered_at) } : {}),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireRow(row: DbWorkItemRow | undefined): DbWorkItemRow {
  if (!row) throw new Error("PostgreSQL did not return the expected work item");
  return row;
}

function finiteIntegerAtLeastOne(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function finitePositive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new TypeError(`${name} must not be empty`);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
