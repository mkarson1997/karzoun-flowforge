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
});
