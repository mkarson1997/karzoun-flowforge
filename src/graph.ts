import { WorkflowValidationError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

export function topologicalLayers(workflow: WorkflowDefinition): string[][] {
  validateWorkflow(workflow);

  const remaining = new Set(workflow.steps.map((step) => step.id));
  const completed = new Set<string>();
  const layers: string[][] = [];

  while (remaining.size > 0) {
    const layer = workflow.steps
      .filter(
        (step) =>
          remaining.has(step.id) && (step.dependsOn ?? []).every((dependency) => completed.has(dependency)),
      )
      .map((step) => step.id);

    if (layer.length === 0) {
      const cycleIds = workflow.steps.filter((step) => remaining.has(step.id)).map((step) => step.id);
      throw new WorkflowValidationError(
        `Workflow contains a dependency cycle involving: ${cycleIds.map((id) => `"${id}"`).join(", ")}`,
      );
    }

    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      completed.add(id);
    }
  }

  return layers;
}

export function topologicalOrder(workflow: WorkflowDefinition): string[] {
  return topologicalLayers(workflow).flat();
}

function validateWorkflow(workflow: WorkflowDefinition): void {
  if (!workflow.id.trim()) {
    throw new WorkflowValidationError("Workflow id must not be empty");
  }

  const byId = new Map(workflow.steps.map((step) => [step.id, step]));
  if (byId.size !== workflow.steps.length) {
    throw new WorkflowValidationError("Step ids must be unique");
  }

  for (const step of workflow.steps) {
    if (!step.id.trim()) {
      throw new WorkflowValidationError("Step id must not be empty");
    }

    for (const dependency of step.dependsOn ?? []) {
      if (!byId.has(dependency)) {
        throw new WorkflowValidationError(`Step "${step.id}" depends on unknown step "${dependency}"`);
      }
      if (dependency === step.id) {
        throw new WorkflowValidationError(`Step "${step.id}" cannot depend on itself`);
      }
    }
  }
}
