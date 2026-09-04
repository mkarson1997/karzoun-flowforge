import { randomUUID } from "node:crypto";
import type { ClaimedWorkItem, PostgresWorkQueue } from "./postgres-work-queue.js";

export interface DurableTaskHandlerInput {
  task: ClaimedWorkItem;
  signal: AbortSignal;
}

export type DurableTaskHandler = (input: DurableTaskHandlerInput) => Promise<unknown> | unknown;

export interface DurableWorkerOptions {
  queue: PostgresWorkQueue;
  handlers: Readonly<Record<string, DurableTaskHandler>>;
  workerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  pollMs?: number;
  retryDelayMs?: number | ((task: ClaimedWorkItem, error: unknown) => number);
  metadata?: unknown;
}

export type DurableWorkerRunResult =
  | { status: "idle" }
  | { status: "completed"; workItemId: string }
  | { status: "retrying"; workItemId: string }
  | { status: "dead_letter"; workItemId: string }
  | { status: "lease_lost"; workItemId: string };

export class DurableWorker {
  readonly #queue: PostgresWorkQueue;
  readonly #handlers: Readonly<Record<string, DurableTaskHandler>>;
  readonly #workerId: string;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #pollMs: number;
  readonly #retryDelayMs: number | ((task: ClaimedWorkItem, error: unknown) => number);
  readonly #metadata: unknown;
  #registered = false;

  constructor(options: DurableWorkerOptions) {
    this.#queue = options.queue;
    this.#handlers = options.handlers;
    this.#workerId = options.workerId ?? `worker-${randomUUID()}`;
    this.#leaseMs = positive(options.leaseMs, 30_000);
    this.#heartbeatMs = positive(options.heartbeatMs, Math.max(1_000, Math.floor(this.#leaseMs / 3)));
    if (this.#heartbeatMs >= this.#leaseMs) {
      throw new TypeError("heartbeatMs must be smaller than leaseMs");
    }
    this.#pollMs = nonNegative(options.pollMs, 1_000);
    this.#retryDelayMs = options.retryDelayMs ?? 0;
    this.#metadata = options.metadata ?? {};
  }

  get workerId(): string {
    return this.#workerId;
  }

  async runOnce(): Promise<DurableWorkerRunResult> {
    await this.#ensureRegistered();
    await this.#queue.heartbeatWorker(this.#workerId);

    const task = await this.#queue.claimNext(this.#workerId, this.#leaseMs);
    if (!task) return { status: "idle" };

    const handler = this.#handlers[task.taskType];
    if (!handler) {
      await this.#queue.deadLetter(task.id, this.#workerId, new Error(`No handler registered for task type "${task.taskType}"`));
      return { status: "dead_letter", workItemId: task.id };
    }

    const controller = new AbortController();
    let leaseLost = false;
    let heartbeatActive = false;

    const heartbeat = async (): Promise<void> => {
      if (heartbeatActive || leaseLost) return;
      heartbeatActive = true;
      try {
        const [workerAlive, leaseAlive] = await Promise.all([
          this.#queue.heartbeatWorker(this.#workerId),
          this.#queue.heartbeatLease(task.id, this.#workerId, this.#leaseMs),
        ]);
        if (!workerAlive || !leaseAlive) {
          leaseLost = true;
          controller.abort(new Error("FlowForge worker lease was lost"));
        }
      } catch (error) {
        leaseLost = true;
        controller.abort(error);
      } finally {
        heartbeatActive = false;
      }
    };

    const timer = setInterval(() => {
      void heartbeat();
    }, this.#heartbeatMs);

    try {
      const output = await handler({ task, signal: controller.signal });
      if (leaseLost) return { status: "lease_lost", workItemId: task.id };

      const completed = await this.#queue.complete(task.id, this.#workerId, output);
      return completed
        ? { status: "completed", workItemId: task.id }
        : { status: "lease_lost", workItemId: task.id };
    } catch (error) {
      if (leaseLost) return { status: "lease_lost", workItemId: task.id };
      const delay = this.#retryDelay(task, error);
      const nextStatus = await this.#queue.fail(task.id, this.#workerId, error, delay);
      if (nextStatus === "queued") return { status: "retrying", workItemId: task.id };
      if (nextStatus === "dead_letter") return { status: "dead_letter", workItemId: task.id };
      return { status: "lease_lost", workItemId: task.id };
    } finally {
      clearInterval(timer);
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    await this.#ensureRegistered();

    while (!signal?.aborted) {
      const result = await this.runOnce();
      if (result.status === "idle" && this.#pollMs > 0) {
        await sleep(this.#pollMs, signal);
      }
    }
  }

  #retryDelay(task: ClaimedWorkItem, error: unknown): number {
    const raw = typeof this.#retryDelayMs === "function" ? this.#retryDelayMs(task, error) : this.#retryDelayMs;
    return nonNegative(raw, 0);
  }

  async #ensureRegistered(): Promise<void> {
    if (this.#registered) return;
    await this.#queue.registerWorker(this.#workerId, this.#metadata);
    this.#registered = true;
  }
}

function positive(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function nonNegative(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
