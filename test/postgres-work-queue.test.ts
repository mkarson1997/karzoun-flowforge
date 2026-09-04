import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { DurableWorker, PostgresWorkQueue } from "../src/index.js";

const connectionString = process.env.FLOWFORGE_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;

describePostgres("PostgresWorkQueue", () => {
  const pool = new Pool({ connectionString });
  const queue = new PostgresWorkQueue({ pool });

  beforeAll(async () => {
    await queue.migrate();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE flowforge.work_items, flowforge.workers");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("prevents duplicate active ownership under concurrent claims", async () => {
    await queue.registerWorker("worker-a");
    await queue.registerWorker("worker-b");
    const enqueued = await queue.enqueue({
      workflowId: "wf",
      runId: "run-1",
      stepId: "step-1",
      taskType: "email",
      payload: { to: "user@example.com" },
    });

    const claims = await Promise.all([queue.claimNext("worker-a", 1_000), queue.claimNext("worker-b", 1_000)]);
    const claimed = claims.filter((item) => item !== undefined);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(enqueued.id);
  });

  it("reclaims an expired lease after worker loss and rejects stale completion", async () => {
    await queue.registerWorker("dead-worker");
    await queue.registerWorker("recovery-worker");
    const item = await queue.enqueue({
      workflowId: "wf",
      runId: "run-recovery",
      stepId: "step-recovery",
      taskType: "recover",
      maxAttempts: 3,
    });

    expect((await queue.claimNext("dead-worker", 40))?.attempts).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const reclaimed = await queue.claimNext("recovery-worker", 1_000);
    expect(reclaimed?.id).toBe(item.id);
    expect(reclaimed?.attempts).toBe(2);
    expect(await queue.complete(item.id, "dead-worker", "stale")).toBe(false);
    expect(await queue.complete(item.id, "recovery-worker", "recovered")).toBe(true);
    expect((await queue.get(item.id))?.result).toBe("recovered");
  });

  it("dead-letters an expired final attempt instead of reclaiming forever", async () => {
    await queue.registerWorker("worker-final");
    await queue.registerWorker("worker-next");
    const item = await queue.enqueue({
      workflowId: "wf",
      runId: "run-final",
      stepId: "step-final",
      taskType: "final",
      maxAttempts: 1,
    });

    await queue.claimNext("worker-final", 40);
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await queue.claimNext("worker-next", 1_000)).toBeUndefined();
    expect((await queue.get(item.id))?.status).toBe("dead_letter");
  });

  it("allows only one winner when a failed task becomes retryable", async () => {
    await queue.registerWorker("worker-1");
    await queue.registerWorker("worker-2");
    await queue.registerWorker("worker-3");
    const item = await queue.enqueue({
      workflowId: "wf",
      runId: "run-retry-race",
      stepId: "step-retry-race",
      taskType: "retry",
      maxAttempts: 3,
    });

    const first = await queue.claimNext("worker-1", 1_000);
    expect(first?.id).toBe(item.id);
    expect(await queue.fail(item.id, "worker-1", new Error("temporary"), 0)).toBe("queued");

    const claims = await Promise.all([queue.claimNext("worker-2", 1_000), queue.claimNext("worker-3", 1_000)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("runs registered task handlers through DurableWorker", async () => {
    const item = await queue.enqueue({
      workflowId: "wf",
      runId: "run-worker",
      stepId: "step-worker",
      taskType: "sum",
      payload: { a: 20, b: 22 },
    });
    const worker = new DurableWorker({
      queue,
      workerId: "worker-runtime",
      leaseMs: 1_000,
      heartbeatMs: 100,
      handlers: {
        sum: ({ task }) => {
          const payload = task.payload as { a: number; b: number };
          return payload.a + payload.b;
        },
      },
    });

    expect(await worker.runOnce()).toEqual({ status: "completed", workItemId: item.id });
    expect((await queue.get(item.id))?.result).toBe(42);
  });

  it("dead-letters work with no registered handler", async () => {
    const item = await queue.enqueue({
      workflowId: "wf",
      runId: "run-missing-handler",
      stepId: "step-missing-handler",
      taskType: "unknown",
    });
    const worker = new DurableWorker({
      queue,
      workerId: "worker-no-handler",
      leaseMs: 1_000,
      heartbeatMs: 100,
      handlers: {},
    });

    expect(await worker.runOnce()).toEqual({ status: "dead_letter", workItemId: item.id });
    expect((await queue.get(item.id))?.status).toBe("dead_letter");
  });
});
