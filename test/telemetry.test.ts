import { describe, expect, it, vi } from "vitest";
import { FlowForge, createOpenTelemetryListener, toStructuredExecutionLog } from "../src/index.js";
import type { Tracer } from "@opentelemetry/api";

describe("telemetry", () => {
  it("is safe and no-op by default when no SDK is registered", async () => {
    const forge = new FlowForge({
      onEvent: createOpenTelemetryListener(),
      makeRunId: () => "run-telemetry",
    });

    const result = await forge.run({
      id: "telemetry-workflow",
      steps: [{ id: "work", run: () => 42 }],
    });

    expect(result.status).toBe("completed");
    expect(result.context.work).toBe(42);
  });

  it("never lets instrumentation failures change workflow results", async () => {
    const onInstrumentationError = vi.fn();
    const brokenTracer = {
      startSpan: () => {
        throw new Error("collector exploded");
      },
    } as unknown as Tracer;

    const forge = new FlowForge({
      onEvent: createOpenTelemetryListener({ tracer: brokenTracer, onInstrumentationError }),
    });

    const result = await forge.run({ id: "safe", steps: [{ id: "step", run: () => "ok" }] });

    expect(result.status).toBe("completed");
    expect(result.context.step).toBe("ok");
    expect(onInstrumentationError).toHaveBeenCalled();
  });

  it("produces correlation-safe structured logs without arbitrary event metadata", () => {
    const record = toStructuredExecutionLog({
      type: "step.retrying",
      workflowId: "billing",
      runId: "run-42",
      stepId: "charge",
      attempt: 1,
      timestamp: "2026-09-04T12:00:00.000Z",
      metadata: {
        delayMs: 250,
        errorName: "ProviderError",
        error: "secret-bearing upstream message",
        output: { token: "must-not-leak" },
      },
    });

    expect(record).toEqual({
      timestamp: "2026-09-04T12:00:00.000Z",
      level: "warn",
      event: "step.retrying",
      correlation_id: "run-42",
      workflow_id: "billing",
      run_id: "run-42",
      step_id: "charge",
      attempt: 1,
      retry_delay_ms: 250,
      error_name: "ProviderError",
    });
    expect(JSON.stringify(record)).not.toContain("token");
    expect(JSON.stringify(record)).not.toContain("secret-bearing");
  });
});
