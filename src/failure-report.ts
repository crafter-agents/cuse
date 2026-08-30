import type {
  ScenarioRunResult,
  ScenarioStepResult,
  ScenarioStepStatus,
  ScenarioStatus,
} from "./scenario-run.ts";
import type { ScenarioStep } from "./scenario.ts";
import type { ScenarioValue } from "./scenario.ts";

type PresentElement = { role: string; name: string };

export type FailureStepReport = {
  index: number;
  phase: ScenarioStepResult["phase"];
  type: ScenarioStep["type"];
  status: Exclude<ScenarioStepStatus, "passed">;
  message?: string;
  presentElements?: PresentElement[];
};

export type FailureReport = {
  status: Exclude<ScenarioStatus, "passed">;
  steps: FailureStepReport[];
};

function presentElementsFrom(data: ScenarioValue | undefined): PresentElement[] | undefined {
  if (data === null || data === undefined || Array.isArray(data) || typeof data !== "object") {
    return undefined;
  }
  const value = data.presentElements;
  if (!Array.isArray(value)) return undefined;
  const elements = value.filter((item): item is PresentElement =>
    item !== null && !Array.isArray(item) && typeof item === "object" &&
    typeof item.role === "string" && typeof item.name === "string"
  );
  return elements.length > 0 ? elements : undefined;
}

export function buildFailureReport(
  result: ScenarioRunResult,
): FailureReport | undefined {
  if (result.status === "passed") return undefined;

  return {
    status: result.status,
    steps: result.steps
      .filter((step) => step.status !== "passed")
      .map((step) => ({
        index: step.index,
        phase: step.phase,
        type: step.step.type,
        status: step.status as Exclude<ScenarioStepStatus, "passed">,
        message: step.message,
        presentElements: presentElementsFrom(step.cuse?.data),
      })),
  };
}

export function formatFailureReport(report: FailureReport): string {
  const lines = [`Scenario ${report.status}.`];

  for (const step of report.steps) {
    lines.push(
      `${step.phase}[${step.index}] (${step.type}) ${step.status}${
        step.message === undefined ? "" : `: ${step.message}`
      }`,
    );
    if (step.presentElements?.length) {
      lines.push(`present: ${step.presentElements.map(({ role, name }) => `${role} '${name}'`).join(", ")}`);
    }
  }

  return lines.join("\n");
}
