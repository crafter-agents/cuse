import { runWithTimeout, type RunResult } from "./exec.ts";
import type {
  AssertStep,
  Scenario,
  ScenarioPlatform,
  ScenarioStep,
  ScenarioValue,
} from "./scenario.ts";

export type ScenarioStepStatus = "passed" | "failed" | "timed_out" | "not_implemented";
export type ScenarioStatus = "passed" | "failed" | "timed_out" | "cleanup_failed" | "skipped";

export type ScenarioStepResult = {
  phase: "steps" | "finally";
  index: number;
  step: ScenarioStep;
  status: ScenarioStepStatus;
  timedOut: boolean;
  attempts: number;
  run?: RunResult;
  message?: string;
};

export type ScenarioRunResult = {
  status: ScenarioStatus;
  steps: ScenarioStepResult[];
};

function currentPlatform(): ScenarioPlatform | undefined {
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  if (process.platform === "win32") return "windows";
  return undefined;
}

function equal(actual: ScenarioValue | undefined, expected: ScenarioValue | undefined): boolean {
  if (actual === expected) return true;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((value, index) => equal(value, expected[index]));
  }
  if (actual && expected && typeof actual === "object" && typeof expected === "object") {
    const actualKeys = Object.keys(actual);
    const expectedKeys = Object.keys(expected);
    return actualKeys.length === expectedKeys.length &&
      actualKeys.every((key) => key in expected && equal(actual[key], expected[key]));
  }
  return false;
}

function assertPasses(step: AssertStep): boolean {
  switch (step.operator) {
    case "eq": return equal(step.actual, step.expected);
    case "ne": return !equal(step.actual, step.expected);
    case "contains":
      if (typeof step.actual === "string" && typeof step.expected === "string") {
        return step.actual.includes(step.expected);
      }
      return Array.isArray(step.actual) && step.actual.some((value) => equal(value, step.expected));
    case "exists": return step.actual !== null && step.actual !== undefined;
    case "gt": return orderedComparison(step.actual, step.expected, "gt");
    case "gte": return orderedComparison(step.actual, step.expected, "gte");
    case "lt": return orderedComparison(step.actual, step.expected, "lt");
    case "lte": return orderedComparison(step.actual, step.expected, "lte");
  }
}

function orderedComparison(
  actual: ScenarioValue,
  expected: ScenarioValue | undefined,
  operator: "gt" | "gte" | "lt" | "lte",
): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    if (operator === "gt") return actual > expected;
    if (operator === "gte") return actual >= expected;
    if (operator === "lt") return actual < expected;
    return actual <= expected;
  }
  if (typeof actual === "string" && typeof expected === "string") {
    if (operator === "gt") return actual > expected;
    if (operator === "gte") return actual >= expected;
    if (operator === "lt") return actual < expected;
    return actual <= expected;
  }
  return false;
}

async function executeStep(
  step: ScenarioStep,
  timeoutMs: number,
): Promise<Omit<ScenarioStepResult, "phase" | "index" | "step">> {
  switch (step.type) {
    case "exec": {
      let run: RunResult;
      try {
        run = await runWithTimeout(step.argv, timeoutMs);
      } catch (error) {
        return {
          status: "failed",
          timedOut: false,
          attempts: 1,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        status: run.timedOut ? "timed_out" : run.code === 0 ? "passed" : "failed",
        timedOut: run.timedOut,
        attempts: 1,
        run,
      };
    }
    case "assert": {
      const passed = assertPasses(step);
      return {
        status: passed ? "passed" : "failed",
        timedOut: false,
        attempts: 1,
        message: passed ? undefined : `assertion ${step.operator} failed`,
      };
    }
    case "cuse":
      return {
        status: "not_implemented",
        timedOut: false,
        attempts: 1,
        message: "cuse step execution is not implemented",
      };
    case "wait": {
      const deadline = Date.now() + timeoutMs;
      const intervalMs = step.intervalMs ?? 100;
      let attempts = 0;
      while (true) {
        attempts++;
        const remaining = Math.max(1, deadline - Date.now());
        const nestedTimeout = Math.min(step.step.timeoutMs ?? timeoutMs, remaining);
        const result = await executeStep(step.step, nestedTimeout);
        if (result.status === "passed" || result.status === "not_implemented") {
          return { ...result, attempts };
        }
        if (Date.now() >= deadline) {
          return {
            ...result,
            status: "timed_out",
            timedOut: true,
            attempts,
            message: "wait step timed out",
          };
        }
        await Bun.sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      }
    }
  }
}

export async function runScenario(scenario: Scenario): Promise<ScenarioRunResult> {
  const platform = currentPlatform();
  if (scenario.platforms && (!platform || !scenario.platforms.includes(platform))) {
    return { status: "skipped", steps: [] };
  }

  const results: ScenarioStepResult[] = [];
  let normalStatus: "passed" | "failed" | "timed_out" = "passed";

  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index]!;
    const result = await executeStep(step, step.timeoutMs ?? scenario.defaultTimeoutMs!);
    results.push({ phase: "steps", index, step, ...result });
    if (result.status !== "passed") {
      normalStatus = result.status === "timed_out" ? "timed_out" : "failed";
      break;
    }
  }

  let cleanupFailed = false;
  for (let index = 0; index < (scenario.finally?.length ?? 0); index++) {
    const step = scenario.finally![index]!;
    const result = await executeStep(step, step.timeoutMs ?? scenario.defaultTimeoutMs!);
    results.push({ phase: "finally", index, step, ...result });
    if (result.status !== "passed") cleanupFailed = true;
  }

  return { status: cleanupFailed ? "cleanup_failed" : normalStatus, steps: results };
}
