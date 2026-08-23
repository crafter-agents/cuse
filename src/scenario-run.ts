import { runWithTimeout, type RunResult } from "./exec.ts";
import { parseJsonDocument, readJsonFile, type ParsedJsonResult } from "./scenario-json.ts";
import type {
  AssertStep,
  Scenario,
  ScenarioPlatform,
  ScenarioStep,
  ScenarioValue,
} from "./scenario.ts";

export type ScenarioStepStatus = "passed" | "failed" | "timed_out" | "not_implemented";
export type ScenarioStatus = "passed" | "failed" | "timed_out" | "cleanup_failed" | "skipped";

export type CuseInvocationResult = {
  ok: boolean;
  error?: string;
  detail?: string;
  data?: ScenarioValue;
};

export type CuseInvoker = (
  action: string,
  args: string[],
  options?: Record<string, ScenarioValue>,
) => Promise<CuseInvocationResult>;

export type ScenarioStepResult = {
  phase: "steps" | "finally";
  index: number;
  step: ScenarioStep;
  status: ScenarioStepStatus;
  timedOut: boolean;
  attempts: number;
  run?: RunResult;
  json?: ParsedJsonResult;
  cuse?: CuseInvocationResult;
  message?: string;
};

export type ScenarioStepEvent =
  | {
    type: "start";
    phase: ScenarioStepResult["phase"];
    index: number;
    step: ScenarioStep;
  }
  | {
    type: "terminal";
    phase: ScenarioStepResult["phase"];
    index: number;
    result: ScenarioStepResult;
  };

export type ScenarioStepEventSink = (event: ScenarioStepEvent) => void | Promise<void>;

export type ScenarioRunOptions = {
  invokeCuse?: CuseInvoker;
  onStepEvent?: ScenarioStepEventSink;
  workDir?: string;
};

export type ScenarioRunResult = {
  status: ScenarioStatus;
  name: string;
  platform: ScenarioPlatform | undefined;
  durationMs: number;
  steps: ScenarioStepResult[];
};

type ScenarioContext = {
  vars: Record<string, ScenarioValue>;
  steps: Record<string, ScenarioValue>;
};

const INTERPOLATION = /\$\{(vars\.[A-Za-z_][\w-]*|steps\.[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\}/g;
const WHOLE_INTERPOLATION = /^\$\{(vars\.[A-Za-z_][\w-]*|steps\.[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\}$/;
const MISSING = Symbol("cuse-missing-field");

function resolveReference(reference: string, context: ScenarioContext): ScenarioValue {
  const [scope, name, ...path] = reference.split(".");
  let value: ScenarioValue | undefined;
  if (scope === "vars") {
    value = Object.hasOwn(context.vars, name!) ? context.vars[name!] : undefined;
  } else {
    value = Object.hasOwn(context.steps, name!) ? context.steps[name!] : undefined;
  }

  if (value === undefined) throw new Error(`missing reference: ${reference}`);
  for (const segment of path) {
    if (value === null || Array.isArray(value) || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      throw new Error(`missing reference: ${reference}`);
    }
    value = value[segment];
  }
  return value;
}

function interpolationText(value: ScenarioValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function resolveValue(value: ScenarioValue, context: ScenarioContext): ScenarioValue {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_INTERPOLATION);
    if (whole) return resolveReference(whole[1]!, context);
    return value.replace(INTERPOLATION, (_, reference: string) =>
      interpolationText(resolveReference(reference, context)));
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, context));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, resolveValue(child, context)]),
    );
  }
  return value;
}

function resolveStep(step: ScenarioStep, context: ScenarioContext): ScenarioStep {
  return resolveValue(step as unknown as ScenarioValue, context) as unknown as ScenarioStep;
}

function resolveAssertOperand(value: ScenarioValue, context: ScenarioContext): ScenarioValue {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_INTERPOLATION);
    if (whole) {
      try {
        return resolveReference(whole[1]!, context);
      } catch {
        return MISSING as unknown as ScenarioValue;
      }
    }
  }
  return resolveValue(value, context);
}

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
    case "exists": return step.actual !== (MISSING as unknown as ScenarioValue);
    case "type": {
      const actual = step.actual as unknown;
      if (step.expected === "missing") return actual === MISSING;
      if (step.expected === "null") return actual === null;
      if (step.expected === "array") return Array.isArray(actual);
      if (step.expected === "object") {
        return actual !== MISSING && actual !== null && typeof actual === "object" && !Array.isArray(actual);
      }
      if (step.expected === "string" || step.expected === "number" || step.expected === "boolean") {
        return typeof actual === step.expected;
      }
      return false;
    }
    case "gt": return orderedComparison(step.actual, step.expected, "gt");
    case "gte": return orderedComparison(step.actual, step.expected, "gte");
    case "lt": return orderedComparison(step.actual, step.expected, "lt");
    case "lte": return orderedComparison(step.actual, step.expected, "lte");
  }
}

function displayValue(value: ScenarioValue | undefined): string {
  if ((value as unknown) === MISSING) return "<missing>";
  return value === undefined ? "undefined" : JSON.stringify(value);
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
  options: ScenarioRunOptions,
): Promise<Omit<ScenarioStepResult, "phase" | "index" | "step">> {
  switch (step.type) {
    case "exec": {
      let run: RunResult;
      try {
        run = await runWithTimeout(step.argv, timeoutMs, { cwd: step.cwd });
      } catch (error) {
        return {
          status: "failed",
          timedOut: false,
          attempts: 1,
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (step.stdout === "json" && run.code === 0 && !run.timedOut) {
        const json = parseJsonDocument(run.stdout, "stdout");
        return {
          status: json.ok ? "passed" : "failed",
          timedOut: false,
          attempts: 1,
          run,
          json,
          message: json.ok ? undefined : `stdout JSON parse failed (${json.kind}): ${json.message}`,
        };
      }
      return {
        status: run.timedOut ? "timed_out" : run.code === 0 ? "passed" : "failed",
        timedOut: run.timedOut,
        attempts: 1,
        run,
      };
    }
    case "json": {
      const json = readJsonFile(step.path, options.workDir ?? process.cwd());
      return {
        status: json.ok ? "passed" : "failed",
        timedOut: false,
        attempts: 1,
        json,
        message: json.ok ? undefined : `JSON file read failed (${json.kind}): ${json.message}`,
      };
    }
    case "assert": {
      const passed = assertPasses(step);
      return {
        status: passed ? "passed" : "failed",
        timedOut: false,
        attempts: 1,
        message: passed ? undefined :
          `assertion ${step.operator} failed: expected ${displayValue(step.expected)}, observed ${displayValue(step.actual)}`,
      };
    }
    case "cuse": {
      if (!options.invokeCuse) {
        return {
          status: "not_implemented",
          timedOut: false,
          attempts: 1,
          message: "cuse step execution is not implemented",
        };
      }
      let cuse: CuseInvocationResult;
      try {
        cuse = await options.invokeCuse(step.action, step.args ?? [], step.options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          status: "failed",
          timedOut: false,
          attempts: 1,
          cuse: { ok: false, error: message },
          message,
        };
      }
      return {
        status: cuse.ok ? "passed" : "failed",
        timedOut: false,
        attempts: 1,
        cuse,
        message: cuse.ok ? undefined : cuse.error ?? cuse.detail ?? "cuse action failed",
      };
    }
    case "wait": {
      const deadline = Date.now() + timeoutMs;
      const intervalMs = step.intervalMs ?? 100;
      let attempts = 0;
      while (true) {
        attempts++;
        const remaining = Math.max(1, deadline - Date.now());
        const nestedTimeout = Math.min(step.step.timeoutMs ?? timeoutMs, remaining);
        const result = await executeStep(step.step, nestedTimeout, options);
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
        if (Date.now() >= deadline) {
          return {
            ...result,
            status: "timed_out",
            timedOut: true,
            attempts,
            message: "wait step timed out",
          };
        }
      }
    }
  }
}

// Saved values are stable, JSON-compatible summaries: exec saves its RunResult,
// assert saves its resolved operands and verdict, cuse saves its invocation
// summary, and wait saves the same summary as its nested step.
function savedValue(
  step: ScenarioStep,
  result: Omit<ScenarioStepResult, "phase" | "index" | "step">,
): ScenarioValue {
  switch (step.type) {
    case "exec": {
      const base = result.run ?? {
        code: -1,
        stdout: "",
        stderr: result.message ?? "command failed before producing a result",
        timedOut: result.timedOut,
      };
      return result.json ? { ...base, json: result.json } : base;
    }
    case "json":
      return result.json ?? {
        ok: false,
        kind: "read_error",
        message: result.message ?? "JSON file read failed",
        byteCount: 0,
      };
    case "assert":
      return { passed: result.status === "passed", actual: step.actual, expected: step.expected ?? null };
    case "cuse": {
      if (!result.cuse) return { status: "not_implemented" };
      return Object.fromEntries(
        Object.entries(result.cuse).filter(([, value]) => value !== undefined),
      );
    }
    case "wait":
      return savedValue(step.step, result);
  }
}

async function runStep(
  step: ScenarioStep,
  timeoutMs: number,
  context: ScenarioContext,
  options: ScenarioRunOptions,
): Promise<Omit<ScenarioStepResult, "phase" | "index" | "step">> {
  let resolvedStep: ScenarioStep;
  try {
    resolvedStep = step.type === "assert"
      ? {
        ...step,
        actual: resolveAssertOperand(step.actual, context),
        ...(step.expected === undefined ? {} : { expected: resolveAssertOperand(step.expected, context) }),
      }
      : resolveStep(step, context);
  } catch (error) {
    return {
      status: "failed",
      timedOut: false,
      attempts: 0,
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const result = await executeStep(resolvedStep, timeoutMs, options);
  const containsMissing = resolvedStep.type === "assert" &&
    ((resolvedStep.actual as unknown) === MISSING || (resolvedStep.expected as unknown) === MISSING);
  if (step.saveAs && !containsMissing) context.steps[step.saveAs] = savedValue(resolvedStep, result);
  return result;
}

async function attemptStep(
  phase: ScenarioStepResult["phase"],
  index: number,
  step: ScenarioStep,
  timeoutMs: number,
  context: ScenarioContext,
  options: ScenarioRunOptions,
): Promise<ScenarioStepResult> {
  await options.onStepEvent?.({ type: "start", phase, index, step });
  const execution = await runStep(step, timeoutMs, context, options);
  const result: ScenarioStepResult = { phase, index, step, ...execution };
  await options.onStepEvent?.({ type: "terminal", phase, index, result });
  return result;
}

export async function runScenario(
  scenario: Scenario,
  options: ScenarioRunOptions = {},
): Promise<ScenarioRunResult> {
  const startedAt = Date.now();
  const platform = currentPlatform();
  if (scenario.platforms && (!platform || !scenario.platforms.includes(platform))) {
    return {
      status: "skipped",
      name: scenario.name,
      platform,
      durationMs: Date.now() - startedAt,
      steps: [],
    };
  }

  const results: ScenarioStepResult[] = [];
  const context: ScenarioContext = { vars: scenario.vars, steps: {} };
  let normalStatus: "passed" | "failed" | "timed_out" = "passed";

  for (let index = 0; index < scenario.steps.length; index++) {
    const step = scenario.steps[index]!;
    const result = await attemptStep(
      "steps",
      index,
      step,
      step.timeoutMs ?? scenario.defaultTimeoutMs!,
      context,
      options,
    );
    results.push(result);
    if (result.status !== "passed") {
      normalStatus = result.status === "timed_out" ? "timed_out" : "failed";
      break;
    }
  }

  let cleanupFailed = false;
  for (let index = 0; index < (scenario.finally?.length ?? 0); index++) {
    const step = scenario.finally![index]!;
    const result = await attemptStep(
      "finally",
      index,
      step,
      step.timeoutMs ?? scenario.defaultTimeoutMs!,
      context,
      options,
    );
    results.push(result);
    if (result.status !== "passed") cleanupFailed = true;
  }

  return {
    status: cleanupFailed ? "cleanup_failed" : normalStatus,
    name: scenario.name,
    platform,
    durationMs: Date.now() - startedAt,
    steps: results,
  };
}
