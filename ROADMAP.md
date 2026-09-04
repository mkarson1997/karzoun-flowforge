# FlowForge Roadmap

FlowForge is being built in narrow, verifiable layers. Each milestone should remain useful on its own.

## v0.1 Core Runtime

- [x] Type-safe workflow definitions
- [x] DAG validation and cycle detection
- [x] Deterministic dependency execution
- [x] Retries with exponential backoff
- [x] Timeouts with AbortSignal propagation
- [x] Idempotency result reuse
- [x] In-memory state store
- [x] Structured execution events
- [x] Run history API
- [ ] Parallel execution of independent steps
- [ ] Explicit cancellation API

## v0.2 Durable Runtime

- [ ] PostgreSQL state store
- [ ] Durable leases and worker heartbeats
- [ ] Crash recovery
- [ ] Dead-letter state
- [ ] Execution resume semantics
- [ ] Database migrations

## v0.3 Triggers & Workers

- [ ] Worker process
- [ ] Cron triggers
- [ ] Signed webhooks
- [ ] Event triggers
- [ ] Concurrency limits
- [ ] Optional Redis queue adapter

## v0.4 Operations

- [ ] REST API
- [ ] CLI
- [ ] OpenTelemetry traces and metrics
- [ ] Structured logs
- [ ] Health/readiness endpoints
- [ ] Docker images and Compose example

## v0.5 Ecosystem

- [ ] Plugin SDK
- [ ] JavaScript/TypeScript task packages
- [ ] Workflow definition schema
- [ ] Web dashboard
- [ ] Examples gallery
- [ ] Performance benchmark suite

## v1.0

A stable API for durable workflow execution with documented persistence, recovery, observability, security, and extension contracts.
