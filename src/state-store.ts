import type { WorkflowResult } from "./types.js";

export type IdempotentLookup = { found: false } | { found: true; value: unknown };

export interface StateStore {
  getIdempotentResult(key: string): Promise<IdempotentLookup>;
  setIdempotentResult(key: string, value: unknown): Promise<void>;
  saveRun(result: WorkflowResult): Promise<void>;
  getRun(runId: string): Promise<WorkflowResult | undefined>;
}

export class InMemoryStateStore implements StateStore {
  readonly #idempotency = new Map<string, unknown>();
  readonly #runs = new Map<string, WorkflowResult>();

  async getIdempotentResult(key: string): Promise<IdempotentLookup> {
    if (!this.#idempotency.has(key)) return { found: false };
    return { found: true, value: this.#idempotency.get(key) };
  }

  async setIdempotentResult(key: string, value: unknown): Promise<void> {
    this.#idempotency.set(key, value);
  }

  async saveRun(result: WorkflowResult): Promise<void> {
    this.#runs.set(result.runId, structuredClone(result));
  }

  async getRun(runId: string): Promise<WorkflowResult | undefined> {
    const value = this.#runs.get(runId);
    return value ? structuredClone(value) : undefined;
  }
}
