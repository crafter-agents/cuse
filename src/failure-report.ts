import type {
  ScenarioRunResult,
  ScenarioStepResult,
  ScenarioStepStatus,
  ScenarioStatus,
} from "./scenario-run.ts";
import type { ScenarioStep } from "./scenario.ts";

export type FailureStepReport = {
  index: number;
  phase: ScenarioStepResult["phase"];
  type: ScenarioStep["type"];
  status: Exclude<ScenarioStepStatus, "passed">;
  message?: string;
};

export type FailureReport = {
  status: Exclude<ScenarioStatus, "passed">;
  steps: FailureStepReport[];
};

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
  }

  return lines.join("\n");
}
