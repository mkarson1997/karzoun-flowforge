import { describe, expect, it, vi } from "vitest";
import { FlowForge, InMemoryStateStore } from "../src/index.js";

describe("FlowForge", () => {
  it("passes dependency output through workflow context", async () => {
    const forge = new FlowForge({ makeRunId: () => "run-1" });
    const result = await forge.run({
      id: "invoice",
      steps: [
        { id: "load", run: () => ({ amount: 42 }) },
        {
          id: "double",
          dependsOn: ["load"],
          run: ({ context }) => (context.load as { amount: number }).amount * 2,
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.context.double).toBe(84);
  });

  it("executes independent DAG steps concurrently", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    let bothStarted!: () => void;
    const bothStartedPromise = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });
    const markStarted = (): void => {
      started += 1;
      if (started === 2) bothStarted();
    };

    const forge = new FlowForge();
    const execution = forge.run({
      id: "parallel",
      steps: [
        {
          id: "left",
          run: async () => {
            markStarted();
            await gate;
            return "L";
          },
        },
        {
          id: "right",
          run: async () => {
            markStarted();
            await gate;
            return "R";
          },
        },
      ],
    });

    await Promise.race([
      bothStartedPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("steps did not start concurrently")), 250)),
    ]);
    expect(started).toBe(2);

    release();
    const result = await execution;
    expect(result.status).toBe("completed");
    expect(result.context).toMatchObject({ left: "L", right: "R" });
  });

  it("waits for every fan-out dependency before starting a fan-in step", async () => {
    const completed: string[] = [];
    const forge = new FlowForge();

    const result = await forge.run({
      id: "fan-in",
      steps: [
        {
          id: "left",
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            completed.push("left");
            return 20;
          },
        },
        {
          id: "right",
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            completed.push("right");
            return 22;
          },
        },
        {
          id: "sum",
          dependsOn: ["left", "right"],
          run: ({ context }) => {
            expect(completed).toHaveLength(2);
            return (context.left as number) + (context.right as number);
          },
        },
      ],
    });

    expect(result.context.sum).toBe(42);
  });

  it("finishes the active layer but never schedules later layers after a failure", async () => {
    const sibling = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "safe";
    });
    const downstream = vi.fn(() => "must-not-run");
    const forge = new FlowForge();

    const result = await forge.run({
      id: "layer-failure",
      steps: [
        { id: "broken", run: () => Promise.reject(new Error("boom")) },
        { id: "sibling", run: sibling },
        { id: "downstream", dependsOn: ["sibling"], run: downstream },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.steps.broken?.status).toBe("failed");
    expect(result.steps.sibling?.status).toBe("completed");
    expect(result.context.sibling).toBe("safe");
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(downstream).not.toHaveBeenCalled();
  });

  it("retries failed steps using the configured policy", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => undefined);
    const forge = new FlowForge({ sleep });

    const result = await forge.run({
      id: "retry",
      steps: [
        {
          id: "unstable",
          retry: { attempts: 3, backoffMs: 10, factor: 2 },
          run: () => {
            calls += 1;
            if (calls < 3) throw new Error("temporary");
            return "ok";
          },
        },
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.steps.unstable?.attempts).toBe(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it("reuses idempotent results across runs", async () => {
    const store = new InMemoryStateStore();
    const run = vi.fn(() => ({ receipt: "R-1" }));
    const forge = new FlowForge({ store });
    const workflow = {
      id: "payment",
      steps: [{ id: "charge", idempotencyKey: "payment:42", run }],
    } as const;

    const first = await forge.run(workflow);
    const second = await forge.run(workflow);

    expect(first.steps.charge?.status).toBe("completed");
    expect(second.steps.charge?.status).toBe("reused");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("reuses undefined idempotent results instead of treating them as a cache miss", async () => {
    const store = new InMemoryStateStore();
    const run = vi.fn(() => undefined);
    const forge = new FlowForge({ store });
    const workflow = {
      id: "notification",
      steps: [{ id: "send", idempotencyKey: "message:42", run }],
    } as const;

    await forge.run(workflow);
    const second = await forge.run(workflow);

    expect(second.steps.send?.status).toBe("reused");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("namespaces idempotency keys by workflow and step", async () => {
    const store = new InMemoryStateStore();
    const forge = new FlowForge({ store });

    const first = await forge.run({
      id: "workflow-a",
      steps: [{ id: "step", idempotencyKey: "same-key", run: () => "A" }],
    });
    const second = await forge.run({
      id: "workflow-b",
      steps: [{ id: "step", idempotencyKey: "same-key", run: () => "B" }],
    });

    expect(first.context.step).toBe("A");
    expect(second.context.step).toBe("B");
  });

  it("fails a workflow when a step exceeds its timeout", async () => {
    const forge = new FlowForge();
    const result = await forge.run({
      id: "timeout",
      steps: [
        {
          id: "slow",
          timeoutMs: 5,
          run: () => new Promise((resolve) => setTimeout(() => resolve("late"), 30)),
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(result.steps.slow?.error?.name).toBe("StepTimeoutError");
  });

  it("emits an inspectable execution event sequence", async () => {
    const events: string[] = [];
    const forge = new FlowForge({
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    await forge.run({ id: "events", steps: [{ id: "one", run: () => 1 }] });

    expect(events).toEqual(["workflow.started", "step.started", "step.completed", "workflow.completed"]);
  });
});
