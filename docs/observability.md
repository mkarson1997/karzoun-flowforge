# Observability and operations

FlowForge exposes production observability without choosing an exporter, collector, metrics backend, or logging vendor for applications.

## OpenTelemetry

`createOpenTelemetryListener()` converts FlowForge execution events into OpenTelemetry spans and metrics using only `@opentelemetry/api`.

```ts
const forge = new FlowForge({
  onEvent: createOpenTelemetryListener(),
});
```

If no OpenTelemetry SDK/provider is registered by the host application, the API is no-op. Applications that want exported traces or metrics register their preferred OpenTelemetry SDK before constructing the listener.

### Spans

- `flowforge.workflow`: one span per workflow run.
- `flowforge.step`: one span per step attempt, including retry attempts.
- Reused idempotent results produce a zero-duration step span marked `flowforge.reused=true`.

Default span attributes contain identifiers and execution metadata only:

- `flowforge.workflow_id`
- `flowforge.run_id`
- `flowforge.correlation_id`
- `flowforge.step_id`
- `flowforge.attempt`
- `flowforge.event`

Step outputs, task payloads, arbitrary event metadata, and raw exception messages are not attached by default. Set `includeErrorMessages: true` only when the deployment has reviewed its error-message data policy.

### Metrics

The listener emits:

- `flowforge.workflow.completed`
- `flowforge.workflow.failed`
- `flowforge.workflow.duration` (ms)
- `flowforge.step.completed`
- `flowforge.step.failed`
- `flowforge.step.retry`
- `flowforge.step.timeout`
- `flowforge.step.duration` (ms)

## Structured logs

`toStructuredExecutionLog()` converts an event into a vendor-neutral JSON record. The workflow run id is also emitted as `correlation_id` so logs can be joined with trace/run data.

The structured record deliberately allowlists fields. Arbitrary event metadata, outputs, payloads, and raw error messages are excluded.

`createStructuredLogListener()` wraps a log writer and contains writer failures so logging outages cannot fail workflows.

## Liveness and readiness

`createOperationalHandler()` is a tiny Node.js request handler that can be mounted directly on `node:http` or adapted into a larger server.

```ts
import { createServer } from "node:http";
import { createOperationalHandler } from "@karzoun/flowforge";

const handler = createOperationalHandler({
  readinessChecks: {
    database: () => databaseIsReady(),
    queue: () => workerQueueIsReady(),
  },
});

createServer(handler).listen(8081);
```

- `GET /healthz` returns 200 when the process can serve the request.
- `GET /readyz` returns 200 only when every configured readiness check succeeds; otherwise 503.
- Readiness responses expose check names and `ok`/`failed` only. Exception messages are suppressed to avoid leaking connection strings or internal topology.

## Recommended dashboard

A useful baseline dashboard should chart workflow throughput, failure rate, p50/p95/p99 workflow duration, step retry rate, timeout rate, dead-letter growth, and worker lease-reclaim activity.

Suggested alerts:

- sustained workflow failure-rate increase over the application's baseline;
- p95 workflow duration above the service SLO;
- non-zero timeout rate after a deploy;
- repeated dead-letter growth;
- repeated lease reclaim, which may indicate worker crashes, GC pauses, network partitions, or overloaded workers;
- readiness remaining failed beyond the deployment's expected warm-up period.

Treat alert thresholds as deployment-specific. FlowForge intentionally does not ship arbitrary global thresholds.
