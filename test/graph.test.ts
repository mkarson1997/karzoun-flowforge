import { describe, expect, it } from "vitest";
import { topologicalLayers, topologicalOrder, WorkflowValidationError } from "../src/index.js";

describe("workflow graph", () => {
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

  it("groups independent work into deterministic execution layers", () => {
    expect(
      topologicalLayers({
        id: "pipeline",
        steps: [
          { id: "compile", run: () => undefined },
          { id: "lint", run: () => undefined },
          { id: "test", dependsOn: ["compile", "lint"], run: () => undefined },
          { id: "package", dependsOn: ["test"], run: () => undefined },
        ],
      }),
    ).toEqual([["compile", "lint"], ["test"], ["package"]]);
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
