import { randomUUID } from "node:crypto";
import { StepTimeoutError } from "./errors.js";
import { topologicalOrder } from "./graph.js";
import { InMemoryStateStore, type StateStore } from "./state-store.js";
import type {
  EventListener,
  ExecutionEvent,
  RetryPolicy,
  SerializedError,
  StepDefinition,
  StepResult,
  StepRunInput,
  WorkflowDefinition,
  WorkflowResult,
} from "./types.js";

export interface FlowForgeOptions {
  store?: StateStore;
  onEvent?: EventListener;
  now?: () => Date;
  makeRunId?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export class FlowForge {
  readonly #store: StateStore;
  readonly #onEvent: EventListener | undefined;
  readonly #now: () => Date;
  readonly #makeRunId: () => string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: FlowForgeOptions = {}) {
    this.#store = options.store ?? new InMemoryStateStore();
    this.#onEvent = options.onEvent;
    this.#now = options.now ?? (() => new Date());
    this.#makeRunId = options.makeRunId ?? randomUUID;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(workflow: WorkflowDefinition): Promise<WorkflowResult> {
    const order = topologicalOrder(workflow);
    const byId = new Map(workflow.steps.map((step) => [step.id, step]));
    const runId = this.#makeRunId();
    const startedAt = this.#now().toISOString();
    const context: Record<string, unknown> = {};
    const steps: Record<string, StepResult> = {};

    await this.#emit({ type: "workflow.started", workflowId: workflow.id, runId, timestamp: startedAt });

    for (const stepId of order) {
      const step = byId.get(stepId);
      if (!step) throw new Error(`Invariant violation: missing step "${stepId}"`);

      const outcome = await this.#executeStep(workflow.id, runId, step, context);
      steps[stepId] = outcome;

      if (outcome.status === "failed") {
        const result = this.#makeResult(workflow.id, runId, startedAt, "failed", steps, context);
        await this.#store.saveRun(result);
        await this.#emit({
          type: "workflow.failed",
          workflowId: workflow.id,
          runId,
          timestamp: result.completedAt,
          stepId,
          metadata: { error: outcome.error?.message ?? "Unknown error" },
        });
        return result;
      }

      context[stepId] = outcome.output;
    }

    const result = this.#makeResult(workflow.id, runId, startedAt, "completed", steps, context);
    await this.#store.saveRun(result);
    await this.#emit({ type: "workflow.completed", workflowId: workflow.id, runId, timestamp: result.completedAt });
    return result;
  }

  async getRun(runId: string): Promise<WorkflowResult | undefined> {
    return this.#store.getRun(runId);
  }

  async #executeStep(
    workflowId: string,
    runId: string,
    step: StepDefinition,
    context: Record<string, unknown>,
  ): Promise<StepResult> {
    const idempotencyInput = { workflowId, runId, stepId: step.id, context };
    const idempotencyKey =
      typeof step.idempotencyKey === "function" ? step.idempotencyKey(idempotencyInput) : step.idempotencyKey;

    if (idempotencyKey) {
      const cached = await this.#store.getIdempotentResult(idempotencyKey);
      if (cached !== undefined) {
        await this.#emit({
          type: "step.reused",
          workflowId,
          runId,
          stepId: step.id,
          timestamp: this.#now().toISOString(),
          metadata: { idempotencyKey },
        });
        return { id: step.id, status: "reused", attempts: 0, output: cached };
      }
    }

    const retry = normalizeRetry(step.retry);
    let lastError: SerializedError | undefined;

    for (let attempt = 1; attempt <= retry.attempts; attempt += 1) {
      await this.#emit({
        type: "step.started",
        workflowId,
        runId,
        stepId: step.id,
        attempt,
        timestamp: this.#now().toISOString(),
      });

      try {
        const output = await this.#runAttempt(workflowId, runId, step, attempt, context);
        if (idempotencyKey) await this.#store.setIdempotentResult(idempotencyKey, output);
        await this.#emit({
          type: "step.completed",
          workflowId,
          runId,
          stepId: step.id,
          attempt,
          timestamp: this.#now().toISOString(),
        });
        return { id: step.id, status: "completed", attempts: attempt, output };
      } catch (error) {
        lastError = serializeError(error);
        if (attempt < retry.attempts) {
          const delayMs = retryDelay(retry, attempt);
          await this.#emit({
            type: "step.retrying",
            workflowId,
            runId,
            stepId: step.id,
            attempt,
            timestamp: this.#now().toISOString(),
            metadata: { delayMs, error: lastError.message },
          });
          if (delayMs > 0) await this.#sleep(delayMs);
        }
      }
    }

    await this.#emit({
      type: "step.failed",
      workflowId,
      runId,
      stepId: step.id,
      attempt: retry.attempts,
      timestamp: this.#now().toISOString(),
      metadata: { error: lastError?.message ?? "Unknown error" },
    });

    return {
      id: step.id,
      status: "failed",
      attempts: retry.attempts,
      ...(lastError ? { error: lastError } : {}),
    };
  }

  async #runAttempt(
    workflowId: string,
    runId: string,
    step: StepDefinition,
    attempt: number,
    context: Record<string, unknown>,
  ): Promise<unknown> {
    const controller = new AbortController();
    const input: StepRunInput = {
      workflowId,
      runId,
      stepId: step.id,
      attempt,
      context: Object.freeze({ ...context }),
      signal: controller.signal,
    };

    if (!step.timeoutMs || step.timeoutMs <= 0) return step.run(input);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new StepTimeoutError(step.id, step.timeoutMs as number));
      }, step.timeoutMs);
    });

    try {
      return await Promise.race([Promise.resolve(step.run(input)), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #makeResult(
    workflowId: string,
    runId: string,
    startedAt: string,
    status: "completed" | "failed",
    steps: Record<string, StepResult>,
    context: Record<string, unknown>,
  ): WorkflowResult {
    return {
      workflowId,
      runId,
      status,
      startedAt,
      completedAt: this.#now().toISOString(),
      steps: { ...steps },
      context: { ...context },
    };
  }

  async #emit(event: ExecutionEvent): Promise<void> {
    await this.#onEvent?.(event);
  }
}

interface NormalizedRetry {
  attempts: number;
  backoffMs: number;
  factor: number;
  maxBackoffMs: number;
}

function normalizeRetry(policy: RetryPolicy | undefined): NormalizedRetry {
  return {
    attempts: Math.max(1, Math.floor(policy?.attempts ?? 1)),
    backoffMs: Math.max(0, policy?.backoffMs ?? 0),
    factor: Math.max(1, policy?.factor ?? 2),
    maxBackoffMs: Math.max(0, policy?.maxBackoffMs ?? Number.MAX_SAFE_INTEGER),
  };
}

function retryDelay(policy: NormalizedRetry, failedAttempt: number): number {
  return Math.min(policy.maxBackoffMs, policy.backoffMs * policy.factor ** (failedAttempt - 1));
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { name: "Error", message: String(error) };
}
