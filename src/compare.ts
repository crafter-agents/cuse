import type { ScenarioRunResult } from "./scenario-run.ts";

export type SetupFailure = {
  kind: "setup_failed";
  message: string;
};

export type ComparisonInput = ScenarioRunResult | SetupFailure | null | undefined;

export type ComparisonVerdict =
  /** The baseline reproduced the failure and the candidate scenario passed. */
  | { kind: "reproduced_and_fixed" }
  /** The baseline reproduced the failure and the candidate scenario still failed. */
  | { kind: "reproduced_and_still_failing" }
  /** The baseline did not reproduce the expected failure, so no fix can be claimed. */
  | { kind: "baseline_unexpectedly_passes"; observedStatus: ScenarioRunResult["status"] }
  /** Baseline or candidate setup failed before its scenario could produce evidence. */
  | { kind: "baseline_or_candidate_setup_failed"; sides: ("baseline" | "candidate")[] }
  /** A run or selected field is absent, incomplete, or otherwise not conclusive. */
  | { kind: "inconclusive_missing_evidence"; missing: string[] };

export type ComparisonFieldPath =
  `steps[${number}].${"run" | "cuse" | "json" | "message"}${string}`;

export type FieldComparison = {
  path: "status" | ComparisonFieldPath;
  baseline: unknown;
  candidate: unknown;
  equal: boolean;
};

export type ScenarioComparison = {
  verdict: ComparisonVerdict;
  fields: FieldComparison[];
};

const FIELD_PATH = /^steps\[(\d+)]\.(run|cuse|json|message)(?:\.([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*))?$/;

function isSetupFailure(input: ComparisonInput): input is SetupFailure {
  return input !== null && input !== undefined && "kind" in input && input.kind === "setup_failed";
}

function isRunResult(input: ComparisonInput): input is ScenarioRunResult {
  return input !== null && input !== undefined && !isSetupFailure(input);
}

function fieldValue(result: ScenarioRunResult, path: ComparisonFieldPath): unknown {
  const match = path.match(FIELD_PATH);
  if (!match) return undefined;

  const step = result.steps[Number(match[1])];
  if (!step) return undefined;

  let value: unknown = step[match[2] as "run" | "cuse" | "json" | "message"];
  for (const segment of match[3]?.split(".") ?? []) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function equal(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => equal(value, right[index]));
  }
  if (typeof left === "object" && left !== null && typeof right === "object" && right !== null) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const keys = Object.keys(leftRecord);
    return keys.length === Object.keys(rightRecord).length &&
      keys.every((key) => Object.hasOwn(rightRecord, key) && equal(leftRecord[key], rightRecord[key]));
  }
  return false;
}

/**
 * Compares already-collected scenario evidence without I/O. By default only
 * status is compared. Durations, timestamps, paths, and all step payloads are
 * excluded unless a caller selects a run, cuse, json, or message field explicitly.
 */
export function compareScenarioResults(
  baseline: ComparisonInput,
  candidate: ComparisonInput,
  additionalFields: readonly ComparisonFieldPath[] = [],
): ScenarioComparison {
  const setupSides: ("baseline" | "candidate")[] = [];
  if (isSetupFailure(baseline)) setupSides.push("baseline");
  if (isSetupFailure(candidate)) setupSides.push("candidate");
  if (setupSides.length > 0) {
    return {
      verdict: { kind: "baseline_or_candidate_setup_failed", sides: setupSides },
      fields: [],
    };
  }

  const missing: string[] = [];
  if (!isRunResult(baseline)) missing.push("baseline");
  else if (baseline.steps.length === 0) missing.push("baseline.steps");
  if (!isRunResult(candidate)) missing.push("candidate");
  else if (candidate.steps.length === 0) missing.push("candidate.steps");
  if (missing.length > 0 || !isRunResult(baseline) || !isRunResult(candidate)) {
    return { verdict: { kind: "inconclusive_missing_evidence", missing }, fields: [] };
  }

  const fields: FieldComparison[] = [{
    path: "status",
    baseline: baseline.status,
    candidate: candidate.status,
    equal: baseline.status === candidate.status,
  }];
  for (const path of additionalFields) {
    const baselineValue = fieldValue(baseline, path);
    const candidateValue = fieldValue(candidate, path);
    fields.push({
      path,
      baseline: baselineValue,
      candidate: candidateValue,
      equal: equal(baselineValue, candidateValue),
    });
    if (baselineValue === undefined) missing.push(`baseline.${path}`);
    if (candidateValue === undefined) missing.push(`candidate.${path}`);
  }
  if (missing.length > 0) {
    return { verdict: { kind: "inconclusive_missing_evidence", missing }, fields };
  }

  if (baseline.status !== "failed") {
    return {
      verdict: { kind: "baseline_unexpectedly_passes", observedStatus: baseline.status },
      fields,
    };
  }
  if (candidate.status === "passed") {
    return { verdict: { kind: "reproduced_and_fixed" }, fields };
  }
  if (candidate.status === "failed" || candidate.status === "timed_out" || candidate.status === "cleanup_failed") {
    return { verdict: { kind: "reproduced_and_still_failing" }, fields };
  }
  return {
    verdict: { kind: "inconclusive_missing_evidence", missing: ["candidate.status"] },
    fields,
  };
}
