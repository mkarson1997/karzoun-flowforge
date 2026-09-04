# PostgreSQL durable state

`PostgresStateStore` is the durable FlowForge persistence adapter. It stores completed/failed run snapshots and idempotency results in PostgreSQL while keeping database concerns outside workflow definitions. The same schema now also supports durable worker registration, leases, crash reclaim, and dead-letter work items.

## Setup

```ts
import { FlowForge, PostgresStateStore } from "@karzoun/flowforge";

const store = new PostgresStateStore({
  connectionString: process.env.DATABASE_URL,
});

await store.migrate();

const forge = new FlowForge({ store });
```

Call `migrate()` during deployment or application startup before accepting workflow traffic. Migrations are idempotent and versions are recorded in `flowforge.schema_migrations`.

If your application already owns a `pg.Pool`, inject it instead. `close()` only closes pools created by the FlowForge adapter; externally supplied pools remain owned by the caller.

## Tables

- `flowforge.runs`: durable run snapshots keyed by `run_id`.
- `flowforge.idempotency_results`: idempotent step results keyed by the engine's namespaced idempotency key.
- `flowforge.workers`: worker registry and heartbeat timestamps.
- `flowforge.work_items`: durable queue, lease, attempt, result, and dead-letter state.
- `flowforge.schema_migrations`: applied schema versions.

## Atomicity and concurrency

Run and idempotency writes use atomic PostgreSQL upserts. Worker claims use transactions with `FOR UPDATE SKIP LOCKED`, so concurrent workers can safely compete for available work without duplicate active ownership.

Lease-bound writes require the current worker id and a non-expired lease. This prevents stale workers from overwriting a task after it has been reclaimed.

## Value contract

Durable outputs support plain JSON-compatible objects, arrays, finite numbers, strings, booleans, `null`, and `undefined`. FlowForge uses a tagged internal representation instead of a magic sentinel, so nested `undefined` values are preserved without collisions with user data.

Unsupported runtime values such as functions, symbols, bigint values, class instances, and circular object graphs are rejected explicitly rather than being silently corrupted.

## Security

- Queries use positional parameters for runtime data.
- The adapter uses a fixed `flowforge` schema, avoiding dynamic identifier interpolation.
- Connection credentials come from the caller or standard `pg` environment configuration and are never stored in workflow definitions or run payloads.
- Run/task payloads may contain sensitive application data; production deployments should apply PostgreSQL access controls, encryption-at-rest policies, retention rules, and backups appropriate to that data.
