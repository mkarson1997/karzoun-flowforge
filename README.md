# Karzoun FlowForge

[![CI](https://github.com/mkarson1997/karzoun-flowforge/actions/workflows/ci.yml/badge.svg)](https://github.com/mkarson1997/karzoun-flowforge/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)

> An open-source, TypeScript-first workflow engine for reliable background automation.

Karzoun FlowForge is a developer-focused workflow runtime for defining, executing, retrying, persisting, distributing, and observing multi-step jobs. It combines a small in-process DAG engine with PostgreSQL durable state and a lease-based worker substrate, while keeping workflow semantics separate from infrastructure adapters.

## Why FlowForge?

Background jobs become hard when they need dependency ordering, parallelism, retries, timeouts, durable state, crash recovery, idempotency, worker coordination, and observability. FlowForge turns those concerns into explicit, testable runtime contracts instead of scattering them across application code.

## What works today

- Strictly typed workflow and step definitions
- DAG validation, cycle detection, fan-out and fan-in
- Parallel execution of independent DAG steps
- Retry policies with exponential backoff
- Step timeouts with `AbortSignal` propagation
- Namespaced idempotency keys, including valid `undefined` cached results
- In-memory state for zero-dependency development
- PostgreSQL durable run and idempotency storage
- Versioned, concurrency-safe PostgreSQL migrations
- Durable work queue with worker registration and heartbeats
- Expiring leases, crash reclaim and stale-worker fencing
- Retry races protected with PostgreSQL row locking
- Dead-letter state for terminal work
- `DurableWorker` task-handler runtime
- OpenTelemetry spans and metrics with no-op defaults
- Safe structured execution logs with correlation ids
- `/healthz` and `/readyz` operational handlers
- CI on Node.js 22 and 24 with a real PostgreSQL service

## Engineering proof points

| Area | What the repository demonstrates |
| --- | --- |
| Workflow semantics | Typed DAGs, cycle detection, fan-out/fan-in and deterministic layer execution. |
| Failure handling | Bounded retries, exponential backoff, cooperative timeouts and explicit failed-layer boundaries. |
| Durable state | PostgreSQL-backed run/idempotency storage behind a portable state-store contract. |
| Distributed workers | Registration, heartbeats, expiring leases, crash reclaim and stale-worker fencing. |
| Concurrency correctness | PostgreSQL row locking protects durable retry races. |
| Idempotency | Workflow/step namespacing and explicit cache-hit semantics, including `undefined` results. |
| Delivery semantics | At-least-once durable work with external-side-effect idempotency documented as an application responsibility. |
| Observability | OpenTelemetry spans/metrics, structured logs and health/readiness without making telemetry a correctness dependency. |
| Verification | Node.js 22/24 matrix with a real PostgreSQL service, typecheck, tests and build behind an aggregate CI gate. |
| Supply-chain security | Checkout, Node setup and CodeQL actions are pinned to reviewed immutable commit SHAs. |

## Core example

```ts
import { FlowForge } from "@karzoun/flowforge";

const forge = new FlowForge();

const result = await forge.run({
  id: "invoice-pipeline",
  steps: [
    { id: "load-invoice", run: async () => ({ invoiceId: "INV-42", total: 199 }) },
    {
      id: "charge",
      dependsOn: ["load-invoice"],
      idempotencyKey: "INV-42:charge",
      retry: { attempts: 3, backoffMs: 250, factor: 2 },
      run: async ({ context }) => ({ charged: true, invoice: context["load-invoice"] }),
    },
    {
      id: "receipt",
      dependsOn: ["charge"],
      run: async ({ context }) => ({ sent: (context.charge as { charged: boolean }).charged }),
    },
  ],
});

console.log(result.status); // "completed"
```

A larger runnable example lives in [`examples/invoice-pipeline.ts`](examples/invoice-pipeline.ts).

## Durable worker example

```ts
import { DurableWorker, PostgresWorkQueue } from "@karzoun/flowforge";

const queue = new PostgresWorkQueue({ connectionString: process.env.DATABASE_URL });
await queue.migrate();

await queue.enqueue({
  workflowId: "billing",
  runId: "run-42",
  stepId: "charge",
  taskType: "invoice.charge",
  payload: { invoiceId: "INV-42" },
});

const worker = new DurableWorker({
  queue,
  handlers: {
    "invoice.charge": async ({ task, signal }) => chargeInvoice(task.payload, { signal }),
  },
});

await worker.start(shutdownSignal);
```

Distributed work is at-least-once. Handlers that perform external side effects should use stable business idempotency keys. See [`docs/workers.md`](docs/workers.md).

## Observability

```ts
const forge = new FlowForge({
  onEvent: createOpenTelemetryListener(),
});
```

FlowForge depends only on the OpenTelemetry API. If the host does not register an SDK/provider, telemetry remains no-op. See [`docs/observability.md`](docs/observability.md) for spans, metrics, safe structured logs, health/readiness endpoints, dashboards, and alert guidance.

## Architecture

```text
Workflow Definition
       |
       v
+----------------------+        +----------------------+
| DAG Engine           |------->| Execution Events     |
| parallel/retry/time  |        | logs / OpenTelemetry |
+----------+-----------+        +----------------------+
           |
           v
+----------------------+        +----------------------+
| StateStore           |        | Durable Work Queue   |
| memory / PostgreSQL  |<------>| leases / recovery    |
+----------------------+        +----------+-----------+
                                           |
                                           v
                                +----------------------+
                                | DurableWorker        |
                                | task handlers        |
                                +----------------------+
```

For current design boundaries, durable-runtime semantics and failure guarantees, see [`docs/architecture.md`](docs/architecture.md), [`docs/postgresql.md`](docs/postgresql.md), and [`docs/workers.md`](docs/workers.md).

## Development

Requirements:

- Node.js 22+
- npm 10+
- PostgreSQL 17 for integration tests

```bash
npm install
npm run typecheck
npm test
npm run build
```

PostgreSQL integration tests run when `FLOWFORGE_TEST_DATABASE_URL` is set. GitHub Actions supplies a real PostgreSQL service automatically.

## Project principles

1. Reliability before cleverness.
2. State transitions must be explicit and inspectable.
3. Workflow definitions should remain portable and serializable where possible.
4. Core execution must not depend on a specific queue or database.
5. Failure behavior is part of the API, not an afterthought.
6. Observability must never become a correctness dependency.

## Security and delivery controls

- Node.js 22 and 24 verification runs against a real PostgreSQL service
- lockfile installation disables package lifecycle scripts during CI dependency installation
- typecheck, tests and build feed a stable aggregate `CI Gate`
- CodeQL analyzes JavaScript/TypeScript
- third-party GitHub Actions are pinned to reviewed immutable commits
- telemetry intentionally excludes step outputs, task payloads, arbitrary metadata and raw error messages by default

## Roadmap

See [`ROADMAP.md`](ROADMAP.md).

## Security

Please read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability. Telemetry intentionally excludes step outputs, task payloads, arbitrary metadata, and raw error messages by default.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
