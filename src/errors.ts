export class WorkflowValidationError extends Error {
  override name = "WorkflowValidationError";
}

export class StepTimeoutError extends Error {
  override name = "StepTimeoutError";

  constructor(stepId: string, timeoutMs: number) {
    super(`Step "${stepId}" exceeded its ${timeoutMs}ms timeout`);
  }
}
