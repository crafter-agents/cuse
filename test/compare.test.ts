import { describe, expect, test } from "bun:test";
import {
  compareScenarioResults,
  type ComparisonInput,
  type SetupFailure,
} from "../src/compare.ts";
import type { ScenarioRunResult, ScenarioStatus } from "../src/scenario-run.ts";

function result(status: ScenarioStatus, value = "PT72H", durationMs = 100): ScenarioRunResult {
  return {
    status,
    name: "retention probe",
    platform: "macos",
    durationMs,
    steps: [{
      phase: "steps",
      index: 0,
      step: { type: "cuse", action: "inspect", timeoutMs: 1_000 },
      status: status === "passed" ? "passed" : "failed",
      timedOut: false,
      attempts: 1,
      cuse: { ok: status === "passed", data: { retention: value } },
    }],
  };
}

describe("scenario comparison", () => {
  test("reports a reproduced failure fixed by the candidate", () => {
    const comparison = compareScenarioResults(result("failed"), result("passed"));
    expect(comparison.verdict.kind).toBe("reproduced_and_fixed");
  });

  test("reports a reproduced failure that still fails", () => {
    const comparison = compareScenarioResults(result("failed"), result("failed"));
    expect(comparison.verdict.kind).toBe("reproduced_and_still_failing");
  });

  test.each([
    ["passed", "passed"],
    ["passed", "failed"],
    ["passed", "timed_out"],
    ["passed", "cleanup_failed"],
    ["passed", "skipped"],
    ["timed_out", "passed"],
    ["cleanup_failed", "passed"],
    ["skipped", "passed"],
  ] as const)(
    "treats baseline status %s as unexpected when candidate is %s",
    (baselineStatus, candidateStatus) => {
      const comparison = compareScenarioResults(result(baselineStatus), result(candidateStatus));
      expect(comparison.verdict.kind).toBe("baseline_unexpectedly_passes");
      expect(comparison.verdict.kind).not.toBe("reproduced_and_fixed");
    },
  );

  test("keeps candidate setup failure distinct from scenario failure", () => {
    const setupFailure: SetupFailure = { kind: "setup_failed", message: "build failed" };
    const comparison = compareScenarioResults(result("failed"), setupFailure);
    expect(comparison.verdict).toEqual({
      kind: "baseline_or_candidate_setup_failed",
      sides: ["candidate"],
    });
  });

  test.each([
    [null, result("passed")],
    [result("failed"), undefined],
    [{ ...result("failed"), steps: [] }, result("passed")],
  ] satisfies [ComparisonInput, ComparisonInput][])("reports incomplete evidence without throwing", (baseline, candidate) => {
    expect(compareScenarioResults(baseline, candidate).verdict.kind)
      .toBe("inconclusive_missing_evidence");
  });

  test("compares a selected probe while excluding volatile duration by default", () => {
    const baseline = result("failed", "PT72H", 120);
    const candidate = result("passed", "PT0S", 9_800);
    const defaultComparison = compareScenarioResults(baseline, candidate);
    const selectedComparison = compareScenarioResults(
      baseline,
      candidate,
      ["steps[0].cuse.data.retention"],
    );

    expect(defaultComparison.fields).toEqual([{
      path: "status",
      baseline: "failed",
      candidate: "passed",
      equal: false,
    }]);
    expect(defaultComparison.fields.some(({ path }) => path.includes("duration"))).toBe(false);
    expect(selectedComparison.fields[1]).toEqual({
      path: "steps[0].cuse.data.retention",
      baseline: "PT72H",
      candidate: "PT0S",
      equal: false,
    });
  });

  test("reports a missing selected field as inconclusive", () => {
    const comparison = compareScenarioResults(
      result("failed"),
      result("passed"),
      ["steps[0].message"],
    );
    expect(comparison.verdict.kind).toBe("inconclusive_missing_evidence");
  });
});
