export const SCENARIO_SCHEMA_VERSION = 1 as const;

export type ScenarioPlatform = "macos" | "linux" | "windows";
export type ScenarioValue = null | boolean | number | string | ScenarioValue[] |
  { [key: string]: ScenarioValue };

type StepBase = {
  name?: string;
  timeoutMs?: number;
  saveAs?: string;
};

export type CuseStep = StepBase & {
  type: "cuse";
  action: string;
  args?: string[];
  options?: Record<string, ScenarioValue>;
  retries?: number;
};

export type ExecStep = StepBase & {
  type: "exec";
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdout?: "text" | "json";
  retries?: number;
};

export type JsonStep = StepBase & {
  type: "json";
  path: string;
  retries?: number;
};

export type AssertOperator = "eq" | "ne" | "contains" | "exists" | "type" | "gt" | "gte" | "lt" | "lte";
export type AssertStep = StepBase & {
  type: "assert";
  actual: ScenarioValue;
  operator: AssertOperator;
  expected?: ScenarioValue;
  retries?: number;
};

export type WaitStep = StepBase & {
  type: "wait";
  intervalMs?: number;
  step: CuseStep | ExecStep | JsonStep | AssertStep;
};

export type ScenarioStep = CuseStep | ExecStep | JsonStep | AssertStep | WaitStep;

export type Scenario = {
  version: typeof SCENARIO_SCHEMA_VERSION;
  name: string;
  platforms?: ScenarioPlatform[];
  vars: Record<string, ScenarioValue>;
  defaultTimeoutMs?: number;
  steps: ScenarioStep[];
  finally?: ScenarioStep[];
};

export type ScenarioValidationError = {
  code: "invalid_scenario";
  path: string;
  message: string;
};

export type ScenarioParseResult =
  | { ok: true; scenario: Scenario }
  | { ok: false; error: ScenarioValidationError };

const PLATFORMS = new Set<ScenarioPlatform>(["macos", "linux", "windows"]);
const ASSERT_OPERATORS = new Set<AssertOperator>(
  ["eq", "ne", "contains", "exists", "type", "gt", "gte", "lt", "lte"],
);
const ASSERT_TYPES = new Set(["string", "number", "boolean", "null", "array", "object", "missing"]);
const INTERPOLATION = /\$\{(?:vars\.[A-Za-z_][\w-]*|steps\.[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)\}/g;

function fail(path: string, message: string): ScenarioParseResult {
  return { ok: false, error: { code: "invalid_scenario", path, message } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function validTimeout(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validRetries(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function interpolationError(value: unknown, path: string): ScenarioParseResult | undefined {
  if (typeof value === "string") {
    const remainder = value.replace(INTERPOLATION, "");
    if (remainder.includes("${")) {
      return fail(path, "invalid interpolation syntax");
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const error = interpolationError(value[index], `${path}[${index}]`);
      if (error) return error;
    }
  } else if (record(value)) {
    for (const [key, child] of Object.entries(value)) {
      const error = interpolationError(child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return undefined;
}

const BASE_KEYS = ["type", "name", "timeoutMs", "saveAs"];

function parseStep(value: unknown, path: string, defaultTimeoutMs?: number, nested = false): ScenarioParseResult | undefined {
  if (!record(value)) return fail(path, "step must be an object");
  if (!validTimeout(value.timeoutMs) && defaultTimeoutMs === undefined) {
    return fail(`${path}.timeoutMs`, "step requires a positive timeoutMs or a bounded defaultTimeoutMs");
  }
  if (value.timeoutMs !== undefined && !validTimeout(value.timeoutMs)) {
    return fail(`${path}.timeoutMs`, "timeoutMs must be a positive finite number");
  }
  if (value.name !== undefined && (typeof value.name !== "string" || value.name.length === 0)) {
    return fail(`${path}.name`, "name must be a non-empty string");
  }
  if (value.saveAs !== undefined && (typeof value.saveAs !== "string" || !/^[A-Za-z_][\w-]*$/.test(value.saveAs))) {
    return fail(`${path}.saveAs`, "saveAs must be an identifier");
  }

  let allowed: string[];
  switch (value.type) {
    case "cuse":
      allowed = [...BASE_KEYS, "action", "args", "options", "retries"];
      if (value.retries !== undefined && !validRetries(value.retries)) return fail(`${path}.retries`, "retries must be a non-negative integer");
      if (typeof value.action !== "string" || value.action.length === 0) return fail(`${path}.action`, "action must be a non-empty string");
      if (value.action === "scenario") return fail(`${path}.action`, "a scenario cannot invoke another scenario");
      if (value.args !== undefined && (!Array.isArray(value.args) || value.args.some((item) => typeof item !== "string"))) return fail(`${path}.args`, "args must be an array of strings");
      if (value.options !== undefined && !record(value.options)) return fail(`${path}.options`, "options must be an object");
      break;
    case "exec":
      allowed = [...BASE_KEYS, "argv", "cwd", "env", "stdout", "retries"];
      if (value.retries !== undefined && !validRetries(value.retries)) return fail(`${path}.retries`, "retries must be a non-negative integer");
      if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.some((item) => typeof item !== "string")) return fail(`${path}.argv`, "argv must be a non-empty array of strings");
      if (value.cwd !== undefined && typeof value.cwd !== "string") return fail(`${path}.cwd`, "cwd must be a string");
      if (value.env !== undefined && (!record(value.env) || Object.values(value.env).some((item) => typeof item !== "string"))) return fail(`${path}.env`, "env must contain string values");
      if (value.stdout !== undefined && value.stdout !== "text" && value.stdout !== "json") return fail(`${path}.stdout`, "stdout must be \"text\" or \"json\"");
      break;
    case "json":
      allowed = [...BASE_KEYS, "path", "retries"];
      if (value.retries !== undefined && !validRetries(value.retries)) return fail(`${path}.retries`, "retries must be a non-negative integer");
      if (typeof value.path !== "string" || value.path.length === 0) return fail(`${path}.path`, "path must be a non-empty string");
      break;
    case "assert":
      allowed = [...BASE_KEYS, "actual", "operator", "expected", "retries"];
      if (value.retries !== undefined && !validRetries(value.retries)) return fail(`${path}.retries`, "retries must be a non-negative integer");
      if (!("actual" in value)) return fail(`${path}.actual`, "actual is required");
      if (!ASSERT_OPERATORS.has(value.operator as AssertOperator)) return fail(`${path}.operator`, "unsupported assertion operator");
      if (value.operator !== "exists" && !("expected" in value)) return fail(`${path}.expected`, "expected is required for this operator");
      if (value.operator === "type" && (typeof value.expected !== "string" || !ASSERT_TYPES.has(value.expected))) {
        return fail(`${path}.expected`, "type assertion expected must be string, number, boolean, null, array, object or missing");
      }
      break;
    case "wait":
      if (nested) return fail(`${path}.type`, "wait steps cannot contain another wait step");
      allowed = [...BASE_KEYS, "intervalMs", "step"];
      if (value.intervalMs !== undefined && !validTimeout(value.intervalMs)) return fail(`${path}.intervalMs`, "intervalMs must be a positive finite number");
      {
        const error = parseStep(value.step, `${path}.step`, value.timeoutMs as number ?? defaultTimeoutMs, true);
        if (error) return error;
      }
      break;
    default:
      return fail(`${path}.type`, "type must be cuse, exec, json, assert or wait");
  }

  const extra = unknownKey(value, new Set(allowed));
  if (extra) return fail(`${path}.${extra}`, `unknown key: ${extra}`);
  return interpolationError(value, path);
}

export function parseScenario(input: unknown): ScenarioParseResult {
  if (!record(input)) return fail("$", "scenario must be an object");
  const extra = unknownKey(input, new Set(["version", "name", "platforms", "vars", "defaultTimeoutMs", "steps", "finally"]));
  if (extra) return fail(`$.${extra}`, `unknown key: ${extra}`);
  if (input.version !== SCENARIO_SCHEMA_VERSION) return fail("$.version", `version must be ${SCENARIO_SCHEMA_VERSION}`);
  if (typeof input.name !== "string" || input.name.length === 0) return fail("$.name", "name must be a non-empty string");
  if (!record(input.vars)) return fail("$.vars", "vars must be an object");
  if (input.defaultTimeoutMs !== undefined && !validTimeout(input.defaultTimeoutMs)) return fail("$.defaultTimeoutMs", "defaultTimeoutMs must be a positive finite number");
  if (input.platforms !== undefined) {
    if (!Array.isArray(input.platforms) || input.platforms.length === 0) return fail("$.platforms", "platforms must be a non-empty array");
    const unsupported = input.platforms.find((platform) => !PLATFORMS.has(platform as ScenarioPlatform));
    if (unsupported !== undefined) return fail("$.platforms", `unsupported platform: ${String(unsupported)}`);
  }
  if (!Array.isArray(input.steps)) return fail("$.steps", "steps must be an array");
  if (input.finally !== undefined && !Array.isArray(input.finally)) return fail("$.finally", "finally must be an array");

  for (const [collection, steps] of [["steps", input.steps], ["finally", input.finally ?? []]] as const) {
    for (let index = 0; index < steps.length; index++) {
      const error = parseStep(steps[index], `$.${collection}[${index}]`, input.defaultTimeoutMs as number | undefined);
      if (error) return error;
    }
  }
  const interpolation = interpolationError(input.vars, "$.vars");
  if (interpolation) return interpolation;
  return { ok: true, scenario: input as Scenario };
}

export { runScenario } from "./scenario-run.ts";
export type {
  ScenarioRunResult,
  ScenarioStatus,
  ScenarioStepResult,
  ScenarioStepStatus,
} from "./scenario-run.ts";
