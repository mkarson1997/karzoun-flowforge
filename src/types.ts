export type WorkflowStatus = "completed" | "failed";
export type StepStatus = "completed" | "failed" | "reused";

export interface RetryPolicy {
  attempts?: number;
  backoffMs?: number;
  factor?: number;
  maxBackoffMs?: number;
}

export interface StepRunInput {
  workflowId: string;
  runId: string;
  stepId: string;
  attempt: number;
  context: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
}

export interface StepDefinition<TResult = unknown> {
  id: string;
  dependsOn?: readonly string[];
  retry?: RetryPolicy;
  timeoutMs?: number;
  idempotencyKey?: string | ((input: Omit<StepRunInput, "attempt" | "signal">) => string | undefined);
  run(input: StepRunInput): Promise<TResult> | TResult;
}

export interface WorkflowDefinition {
  id: string;
  steps: readonly StepDefinition[];
}

export interface StepResult {
  id: string;
  status: StepStatus;
  attempts: number;
  output?: unknown;
  error?: SerializedError;
}

export interface WorkflowResult {
  workflowId: string;
  runId: string;
  status: WorkflowStatus;
  startedAt: string;
  completedAt: string;
  steps: Record<string, StepResult>;
  context: Record<string, unknown>;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type ExecutionEventType =
  | "workflow.started"
  | "workflow.completed"
  | "workflow.failed"
  | "step.started"
  | "step.completed"
  | "step.retrying"
  | "step.failed"
  | "step.reused";

export interface ExecutionEvent {
  type: ExecutionEventType;
  workflowId: string;
  runId: string;
  timestamp: string;
  stepId?: string;
  attempt?: number;
  metadata?: Record<string, unknown>;
}

export type EventListener = (event: ExecutionEvent) => void | Promise<void>;
