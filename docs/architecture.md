# Architecture

FlowForge separates workflow semantics from infrastructure adapters. The core package owns validation, scheduling semantics, retries, timeouts, idempotency, execution events, and the state-store contract. Databases, queues, HTTP servers, dashboards, and trigger transports belong outside that core.

## Core execution path

```text
WorkflowDefinition
       |
       v
+--------------------+
| DAG validation     |
| - unique ids       |
| - dependency refs  |
| - cycle detection  |
+--------------------+
       |
       v
+--------------------+
| deterministic      |
| topological order  |
+--------------------+
       |
       v
+--------------------+       +-------------------+
| step executor      |------>| execution events  |
| - retry            |       +-------------------+
| - backoff          |
| - timeout          |
| - AbortSignal      |
| - idempotency      |
+--------------------+
       |
       v
+--------------------+
| StateStore         |
| - run snapshots    |
| - idempotent data  |
+--------------------+
```

## Design boundaries

### Workflow definition

A workflow is a stable identifier plus steps. Each step may depend on previous steps and receives an immutable snapshot of completed outputs through `context`.

### Graph validation

Validation happens before any work begins. Unknown dependencies, duplicate ids, self-dependencies, and cycles are rejected before side effects can occur.

### Retry behavior

Retries are a step-level contract. Attempts, initial backoff, multiplier, and maximum backoff are normalized at runtime so malformed numeric values cannot create infinite retry loops.

### Timeouts

A timed step receives an `AbortSignal`. When the timeout expires FlowForge aborts the signal and marks the attempt failed. JavaScript cannot forcibly stop arbitrary user code, so step implementations should cooperate with the signal when invoking cancellable APIs.

### Idempotency

User idempotency keys are namespaced internally by workflow and step. The store lookup is an explicit `{ found, value }` result so `undefined` remains a valid cached output rather than being mistaken for a cache miss.

### State store

The current `InMemoryStateStore` is intentionally small. Durable implementations must preserve the same observable semantics while adding transactional persistence, leases, crash recovery, and concurrency control.

## Next architectural milestone

The durable runtime will introduce PostgreSQL persistence and worker leases without moving database concepts into workflow definitions. This boundary is critical: workflows should remain portable while infrastructure evolves around them.
