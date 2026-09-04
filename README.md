# Karzoun FlowForge

> An open-source, TypeScript-first workflow engine for reliable background automation.

Karzoun FlowForge is a developer-focused workflow runtime for defining, executing, retrying, and observing multi-step jobs. It is designed around deterministic workflow definitions, explicit state transitions, retry policies, idempotency, and pluggable persistence.

## Why FlowForge?

Background jobs become hard when they need retries, timeouts, dependencies, durable state, observability, and safe recovery after crashes. FlowForge turns those concerns into a small, testable execution model instead of scattering them across application code.

## Current scope

The first milestone focuses on the core runtime:

- Typed workflow and step definitions
- DAG validation and cycle detection
- Deterministic dependency scheduling
- Retry policies with exponential backoff
- Step timeouts and cancellation support
- Idempotency keys
- In-memory state store for development and tests
- Structured execution events and history
- CLI-ready package boundaries
- Unit tests for critical engine behavior

Planned next milestones add PostgreSQL persistence, distributed workers, webhook and cron triggers, OpenTelemetry, a REST API, a plugin SDK, and an optional Redis-backed queue.

## Example

```ts
import { FlowForge } from "@karzoun/flowforge";

const forge = new FlowForge();

const result = await forge.run({
  id: "invoice-pipeline",
  steps: [
    {
      id: "load-invoice",
      run: async () => ({ invoiceId: "INV-42", total: 199 }),
    },
    {
      id: "charge",
      dependsOn: ["load-invoice"],
      retry: { attempts: 3, backoffMs: 250, factor: 2 },
      run: async ({ context }) => ({ charged: true, invoice: context["load-invoice"] }),
    },
    {
      id: "receipt",
      dependsOn: ["charge"],
      run: async ({ context }) => ({ sent: context.charge.charged }),
    },
  ],
});

console.log(result.status); // "completed"
```

## Architecture

```text
Workflow Definition
       |
       v
+-------------------+
| Validation / DAG  |
+-------------------+
       |
       v
+-------------------+      +------------------+
| Execution Engine  |----->| Execution Events |
+-------------------+      +------------------+
       |
       +-----------> Retry / Timeout / Idempotency
       |
       v
+-------------------+
| StateStore        |
| in-memory now     |
| PostgreSQL next   |
+-------------------+
```

## Development

Requirements:

- Node.js 22+
- npm 10+

```bash
npm install
npm test
npm run typecheck
npm run build
```

## Project principles

1. Reliability before cleverness.
2. State transitions must be explicit and inspectable.
3. Workflow definitions should remain portable and serializable where possible.
4. Core execution must not depend on a specific queue or database.
5. Failure behavior is part of the API, not an afterthought.

## Roadmap

See [`ROADMAP.md`](ROADMAP.md).

## Security

Please read [`SECURITY.md`](SECURITY.md) before reporting a vulnerability.

## Contributing

Contributions are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
