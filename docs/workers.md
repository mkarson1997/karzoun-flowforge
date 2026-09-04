# Durable workers, leases, and crash recovery

FlowForge's PostgreSQL worker substrate provides at-least-once task execution across processes. It deliberately uses serializable task types and payloads rather than attempting to move JavaScript functions between machines.

## Model

A durable work item identifies `(workflow_id, run_id, step_id)` and a `task_type`. The `(run_id, step_id)` pair is unique, so enqueueing the same step again returns the existing work item instead of creating duplicate active work.

Workers register an id and heartbeat. A claim is an expiring lease stored on the work item. Claims use a PostgreSQL transaction plus `FOR UPDATE SKIP LOCKED`, allowing multiple worker processes to compete without two workers owning the same task simultaneously.

## Crash recovery

If a worker disappears, its lease eventually expires. A later worker can reclaim the work item if attempts remain. The claim attempt counter is incremented on every ownership acquisition, including crash recovery.

A stale worker cannot complete or fail work after its lease expires. Completion, failure, and lease-heartbeat updates require the current worker id and a still-live lease. This acts as a fencing boundary against late results from a dead or partitioned worker.

If the final allowed attempt expires, the work item is moved to `dead_letter` instead of being reclaimed forever.

## At-least-once boundary

A process can perform an external side effect and crash before FlowForge records completion. The task may then run again after lease expiry. This is the standard at-least-once execution boundary.

Handlers that call external systems should therefore use the workflow/step identity or another stable business key as an idempotency key whenever the external system supports one. FlowForge's core idempotency store protects cached step results, but it cannot retroactively undo a side effect that happened outside the database before a crash.

## DurableWorker

`DurableWorker` maps serializable `taskType` values to local handler functions:

```ts
const worker = new DurableWorker({
  queue,
  handlers: {
    "invoice.charge": async ({ task, signal }) => {
      return chargeInvoice(task.payload, { signal });
    },
  },
});

await worker.start(shutdownSignal);
```

While a handler runs, the worker heartbeats both its worker record and its lease. If the lease is lost, the handler receives an aborted signal and the stale worker is prevented from committing a result.

## Failure semantics

- Handler success: work becomes `completed` with a durable result payload.
- Handler failure with attempts remaining: work returns to `queued`, optionally delayed.
- Handler failure on the final attempt: work becomes `dead_letter`.
- Missing handler: work is dead-lettered immediately.
- Worker crash/partition: the lease expires and another worker can reclaim the task.

## Current boundary

The worker substrate is intentionally separate from in-process `StepDefinition.run` functions. Distributed execution requires serializable task descriptions and a handler registry. Future workflow integration will schedule eligible serializable steps onto this queue while preserving the existing in-process API for local workflows.
