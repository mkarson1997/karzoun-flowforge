import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { PostgresStateStore, type WorkflowResult } from "../src/index.js";

const connectionString = process.env.FLOWFORGE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgresStateStore", () => {
  const pool = new Pool({ connectionString });
  const store = new PostgresStateStore({ pool });

  beforeAll(async () => {
    await store.migrate();
    await store.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE flowforge.runs, flowforge.idempotency_results");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("persists run snapshots across store instances", async () => {
    const result: WorkflowResult = {
      workflowId: "invoice",
      runId: "run-persisted",
      status: "completed",
      startedAt: "2026-09-04T12:00:00.000Z",
      completedAt: "2026-09-04T12:00:01.000Z",
      steps: {
        load: { id: "load", status: "completed", attempts: 1, output: undefined },
      },
      context: {
        load: undefined,
        nested: { value: undefined },
      },
    };

    await store.saveRun(result);
    const secondStore = new PostgresStateStore({ pool });
    expect(await secondStore.getRun(result.runId)).toEqual(result);
  });

  it("preserves an undefined idempotent result as an existing value", async () => {
    await store.setIdempotentResult("notification:42", undefined);

    expect(await store.getIdempotentResult("notification:42")).toEqual({ found: true, value: undefined });
    expect(await store.getIdempotentResult("missing")).toEqual({ found: false });
  });

  it("upserts run snapshots atomically by run id", async () => {
    const base: WorkflowResult = {
      workflowId: "retryable",
      runId: "same-run",
      status: "failed",
      startedAt: "2026-09-04T12:00:00.000Z",
      completedAt: "2026-09-04T12:00:01.000Z",
      steps: {},
      context: {},
    };

    await store.saveRun(base);
    await store.saveRun({ ...base, status: "completed", completedAt: "2026-09-04T12:00:02.000Z" });

    expect((await store.getRun(base.runId))?.status).toBe("completed");
  });

  it("records the initial schema migration once", async () => {
    const result = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM flowforge.schema_migrations WHERE version = 1",
    );
    expect(result.rows[0]?.count).toBe("1");
  });
});
