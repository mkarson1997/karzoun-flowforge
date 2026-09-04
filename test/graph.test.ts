import { describe, expect, it } from "vitest";
import { topologicalOrder, WorkflowValidationError } from "../src/index.js";

describe("topologicalOrder", () => {
  it("orders dependencies before dependants", () => {
    expect(
      topologicalOrder({
        id: "build",
        steps: [
          { id: "deploy", dependsOn: ["test"], run: () => undefined },
          { id: "test", dependsOn: ["compile"], run: () => undefined },
          { id: "compile", run: () => undefined },
        ],
      }),
    ).toEqual(["compile", "test", "deploy"]);
  });

  it("rejects cycles", () => {
    expect(() =>
      topologicalOrder({
        id: "cycle",
        steps: [
          { id: "a", dependsOn: ["b"], run: () => undefined },
          { id: "b", dependsOn: ["a"], run: () => undefined },
        ],
      }),
    ).toThrow(WorkflowValidationError);
  });
});
