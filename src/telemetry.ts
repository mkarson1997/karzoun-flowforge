import {
  metrics,
  SpanStatusCode,
  trace,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { EventListener, ExecutionEvent } from "./types.js";

export interface OpenTelemetryListenerOptions {
  tracer?: Tracer;
  meter?: Meter;
  instrumentationName?: string;
  includeErrorMessages?: boolean;
  onInstrumentationError?: (error: unknown) => void;
}

interface ActiveSpan {
  span: Span;
  startedAtMs: number;
}

export function createOpenTelemetryListener(options: OpenTelemetryListenerOptions = {}): EventListener {
  const name = options.instrumentationName ?? "@karzoun/flowforge";
  const tracer = options.tracer ?? trace.getTracer(name);
  const meter = options.meter ?? metrics.getMeter(name);

  const workflowSpans = new Map<string, ActiveSpan>();
  const stepSpans = new Map<string, ActiveSpan>();

  const workflowCompleted = meter.createCounter("flowforge.workflow.completed", {
    description: "Number of successfully completed FlowForge workflows",
  });
  const workflowFailed = meter.createCounter("flowforge.workflow.failed", {
    description: "Number of failed FlowForge workflows",
  });
  const workflowDuration = meter.createHistogram("flowforge.workflow.duration", {
    description: "FlowForge workflow duration",
    unit: "ms",
  });
  const stepCompleted = meter.createCounter("flowforge.step.completed", {
    description: "Number of successfully completed or reused FlowForge steps",
  });
  const stepFailed = meter.createCounter("flowforge.step.failed", {
    description: "Number of terminally failed FlowForge steps",
  });
  const stepRetry = meter.createCounter("flowforge.step.retry", {
    description: "Number of FlowForge step retries",
  });
  const stepTimeout = meter.createCounter("flowforge.step.timeout", {
    description: "Number of FlowForge step timeouts",
  });
  const stepDuration = meter.createHistogram("flowforge.step.duration", {
    description: "FlowForge step attempt duration",
    unit: "ms",
  });

  return async (event) => {
    try {
      const attributes = eventAttributes(event);
      const eventTime = new Date(event.timestamp);
      const eventTimeMs = eventTime.getTime();

      switch (event.type) {
        case "workflow.started": {
          const span = tracer.startSpan("flowforge.workflow", {
            startTime: eventTime,
            attributes,
          });
          workflowSpans.set(event.runId, { span, startedAtMs: eventTimeMs });
          break;
        }
        case "workflow.completed": {
          const active = workflowSpans.get(event.runId);
          active?.span.setStatus({ code: SpanStatusCode.OK });
          active?.span.end(eventTime);
          if (active) workflowDuration.record(nonNegativeDuration(eventTimeMs, active.startedAtMs), attributes);
          workflowSpans.delete(event.runId);
          workflowCompleted.add(1, attributes);
          break;
        }
        case "workflow.failed": {
          const active = workflowSpans.get(event.runId);
          active?.span.setStatus(errorStatus(event, options.includeErrorMessages));
          active?.span.end(eventTime);
          if (active) workflowDuration.record(nonNegativeDuration(eventTimeMs, active.startedAtMs), attributes);
          workflowSpans.delete(event.runId);
          workflowFailed.add(1, attributes);
          break;
        }
        case "step.started": {
          const span = tracer.startSpan("flowforge.step", {
            startTime: eventTime,
            attributes,
          });
          stepSpans.set(stepSpanKey(event), { span, startedAtMs: eventTimeMs });
          break;
        }
        case "step.completed": {
          const key = stepSpanKey(event);
          const active = stepSpans.get(key);
          active?.span.setStatus({ code: SpanStatusCode.OK });
          active?.span.end(eventTime);
          if (active) stepDuration.record(nonNegativeDuration(eventTimeMs, active.startedAtMs), attributes);
          stepSpans.delete(key);
          stepCompleted.add(1, attributes);
          break;
        }
        case "step.retrying": {
          const key = stepSpanKey(event);
          const active = stepSpans.get(key);
          active?.span.setStatus(errorStatus(event, options.includeErrorMessages));
          const delayMs = numericMetadata(event, "delayMs");
          if (delayMs !== undefined) active?.span.setAttribute("flowforge.retry_delay_ms", delayMs);
          active?.span.end(eventTime);
          if (active) stepDuration.record(nonNegativeDuration(eventTimeMs, active.startedAtMs), attributes);
          stepSpans.delete(key);
          stepRetry.add(1, attributes);
          break;
        }
        case "step.failed": {
          const key = stepSpanKey(event);
          const active = stepSpans.get(key);
          active?.span.setStatus(errorStatus(event, options.includeErrorMessages));
          active?.span.end(eventTime);
          if (active) stepDuration.record(nonNegativeDuration(eventTimeMs, active.startedAtMs), attributes);
          stepSpans.delete(key);
          stepFailed.add(1, attributes);
          if (stringMetadata(event, "errorName") === "StepTimeoutError") stepTimeout.add(1, attributes);
          break;
        }
        case "step.reused": {
          const span = tracer.startSpan("flowforge.step", {
            startTime: eventTime,
            attributes: { ...attributes, "flowforge.reused": true },
          });
          span.setStatus({ code: SpanStatusCode.OK });
          span.end(eventTime);
          stepCompleted.add(1, { ...attributes, "flowforge.reused": true });
          stepDuration.record(0, { ...attributes, "flowforge.reused": true });
          break;
        }
      }
    } catch (error) {
      try {
        options.onInstrumentationError?.(error);
      } catch {
        // Telemetry must never alter workflow execution.
      }
    }
  };
}

export type StructuredLogLevel = "info" | "warn" | "error";

export interface StructuredExecutionLog {
  timestamp: string;
  level: StructuredLogLevel;
  event: ExecutionEvent["type"];
  correlation_id: string;
  workflow_id: string;
  run_id: string;
  step_id?: string;
  attempt?: number;
  retry_delay_ms?: number;
  error_name?: string;
}

export function toStructuredExecutionLog(event: ExecutionEvent): StructuredExecutionLog {
  const delayMs = numericMetadata(event, "delayMs");
  const errorName = stringMetadata(event, "errorName");

  return {
    timestamp: event.timestamp,
    level: event.type.endsWith("failed") ? "error" : event.type === "step.retrying" ? "warn" : "info",
    event: event.type,
    correlation_id: event.runId,
    workflow_id: event.workflowId,
    run_id: event.runId,
    ...(event.stepId ? { step_id: event.stepId } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(delayMs !== undefined ? { retry_delay_ms: delayMs } : {}),
    ...(errorName ? { error_name: errorName } : {}),
  };
}

export function createStructuredLogListener(
  write: (record: StructuredExecutionLog) => void | Promise<void>,
  onWriteError?: (error: unknown) => void,
): EventListener {
  return async (event) => {
    try {
      await write(toStructuredExecutionLog(event));
    } catch (error) {
      try {
        onWriteError?.(error);
      } catch {
        // Logging must never alter workflow execution.
      }
    }
  };
}

function eventAttributes(event: ExecutionEvent): Record<string, string | number | boolean> {
  return {
    "flowforge.workflow_id": event.workflowId,
    "flowforge.run_id": event.runId,
    "flowforge.correlation_id": event.runId,
    "flowforge.event": event.type,
    ...(event.stepId ? { "flowforge.step_id": event.stepId } : {}),
    ...(event.attempt !== undefined ? { "flowforge.attempt": event.attempt } : {}),
  };
}

function stepSpanKey(event: ExecutionEvent): string {
  return `${event.runId}:${event.stepId ?? ""}:${event.attempt ?? 0}`;
}

function errorStatus(event: ExecutionEvent, includeMessage = false): { code: SpanStatusCode; message?: string } {
  if (!includeMessage) return { code: SpanStatusCode.ERROR };
  const message = stringMetadata(event, "error");
  return message ? { code: SpanStatusCode.ERROR, message } : { code: SpanStatusCode.ERROR };
}

function numericMetadata(event: ExecutionEvent, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMetadata(event: ExecutionEvent, key: string): string | undefined {
  const value = event.metadata?.[key];
  return typeof value === "string" ? value : undefined;
}

function nonNegativeDuration(endMs: number, startMs: number): number {
  if (!Number.isFinite(endMs) || !Number.isFinite(startMs)) return 0;
  return Math.max(0, endMs - startMs);
}
