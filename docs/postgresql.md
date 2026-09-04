# PostgreSQL durable state

`PostgresStateStore` is the first durable FlowForge persistence adapter. It stores completed/failed run snapshots and idempotency results in PostgreSQL while keeping database concerns outside workflow definitions.

## Setup

```ts
import { FlowForge, PostgresStateStore } from "@karzoun/flowforge";

const store = new PostgresStateStore({
  connectionString: process.env.DATABASE_URL,
});

await store.migrate();

const forge = new FlowForge({ store });
```

Call `migrate()` during deployment or application startup before accepting workflow traffic. The migration is idempotent and records schema version `1` in `flowforge.schema_migrations`.

If your application already owns a `pg.Pool`, inject it instead:

```ts
const store = new PostgresStateStore({ pool });
```

`close()` only closes pools created by `PostgresStateStore`; externally supplied pools remain owned by the caller.

## Tables

- `flowforge.runs`: durable run snapshots keyed by `run_id`.
- `flowforge.idempotency_results`: idempotent step results keyed by the engine's namespaced idempotency key.
- `flowforge.schema_migrations`: applied schema versions.

The run table has an additional `(workflow_id, started_at DESC)` index for workflow-history queries. Primary keys provide indexes for run and idempotency lookups.

## Atomicity

Each run snapshot and idempotency write is a single PostgreSQL `INSERT ... ON CONFLICT DO UPDATE` statement. PostgreSQL executes each statement atomically, so readers cannot observe a partially written payload.

Worker leases and multi-record recovery transactions belong to the later durable-worker milestone.

## Value contract

Durable outputs support plain JSON-compatible objects, arrays, finite numbers, strings, booleans, `null`, and `undefined`. FlowForge uses a tagged internal representation instead of a magic sentinel, so nested `undefined` values are preserved without collisions with user data.

Unsupported runtime values such as functions, symbols, bigint values, class instances, and circular object graphs are rejected explicitly rather than being silently corrupted.

## Security

- Queries use positional parameters for runtime data.
- The adapter uses a fixed `flowforge` schema, avoiding dynamic identifier interpolation.
- Connection credentials come from the caller or standard `pg` environment configuration and are never stored in workflow definitions or run payloads.
- Run payloads may contain sensitive application data; production deployments should apply PostgreSQL access controls, encryption-at-rest policies, retention rules, and backups appropriate to that data.
