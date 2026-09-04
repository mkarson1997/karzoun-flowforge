import { WorkflowValidationError } from "./errors.js";
import type { WorkflowDefinition } from "./types.js";

export function topologicalOrder(workflow: WorkflowDefinition): string[] {
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

  const permanent = new Set<string>();
  const temporary = new Set<string>();
  const order: string[] = [];

  const visit = (id: string): void => {
    if (permanent.has(id)) return;
    if (temporary.has(id)) {
      throw new WorkflowValidationError(`Workflow contains a dependency cycle involving "${id}"`);
    }

    temporary.add(id);
    const step = byId.get(id);
    if (!step) throw new WorkflowValidationError(`Unknown step "${id}"`);
    for (const dependency of step.dependsOn ?? []) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    order.push(id);
  };

  for (const step of workflow.steps) visit(step.id);
  return order;
}
