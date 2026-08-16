import { describe, expect, test } from "bun:test";
import { cleanupComparisonRunDirs } from "../src/compare-isolation.ts";
import { runComparison } from "../src/compare-run.ts";
import { buildComparisonReport } from "../src/compare-report.ts";
import { compareScenarioResults } from "../src/compare.ts";
import type { ScenarioRunResult, ScenarioStatus } from "../src/scenario-run.ts";

function result(status: ScenarioStatus, value = "PT72H"): ScenarioRunResult {
  return {
    status,
    name: "retention probe",
    platform: "macos",
    durationMs: 10,
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

const successfulSetup = { argv: ["true"], cwd: "/tmp" };
const failingSetup = { argv: ["false"], cwd: "/tmp" };

describe("comparison run orchestration", () => {
  test("runs both successful sides in distinct isolated directories", async () => {
    const baseline = result("failed");
    const candidate = result("passed");
    const seen: { workDir: string; evidenceDir: string }[] = [];
    const run = await runComparison(
      { scenario: "scenario.json", baseline: successfulSetup, candidate: successfulSetup },
      {
        baseline: async (dirs) => { seen.push(dirs); return baseline; },
        candidate: async (dirs) => { seen.push(dirs); return candidate; },
      },
    );

    try {
      expect(seen).toHaveLength(2);
      expect(seen[0]).not.toEqual(seen[1]);
      expect(run.report).toEqual(
        buildComparisonReport(compareScenarioResults(baseline, candidate)),
      );
    } finally {
      await cleanupComparisonRunDirs(run.dirs);
    }
  });

  test("retains candidate execution when baseline setup fails", async () => {
    let baselineCalls = 0;
    let candidateCalls = 0;
    const run = await runComparison(
      { scenario: "scenario.json", baseline: failingSetup, candidate: successfulSetup },
      {
        baseline: async () => { baselineCalls++; return result("failed"); },
        candidate: async () => { candidateCalls++; return result("passed"); },
      },
    );

    try {
      expect(baselineCalls).toBe(0);
      expect(candidateCalls).toBe(1);
      expect(run.report.verdict).toEqual({
        kind: "baseline_or_candidate_setup_failed",
        sides: ["baseline"],
      });
    } finally {
      await cleanupComparisonRunDirs(run.dirs);
    }
  });

  test("retains baseline execution when candidate setup fails", async () => {
    let baselineCalls = 0;
    let candidateCalls = 0;
    const run = await runComparison(
      { scenario: "scenario.json", baseline: successfulSetup, candidate: failingSetup },
      {
        baseline: async () => { baselineCalls++; return result("failed"); },
        candidate: async () => { candidateCalls++; return result("passed"); },
      },
    );

    try {
      expect(baselineCalls).toBe(1);
      expect(candidateCalls).toBe(0);
      expect(run.report.verdict).toEqual({
        kind: "baseline_or_candidate_setup_failed",
        sides: ["candidate"],
      });
    } finally {
      await cleanupComparisonRunDirs(run.dirs);
    }
  });

  test("threads selected fields into the differential report", async () => {
    const path = "steps[0].cuse.data.retention" as const;
    const run = await runComparison(
      {
        scenario: "scenario.json",
        baseline: successfulSetup,
        candidate: successfulSetup,
        fields: [path],
      },
      {
        baseline: async () => result("failed", "PT72H"),
        candidate: async () => result("passed", "PT0S"),
      },
    );

    try {
      expect(run.report.changedFields.some((field) => field.path === path)).toBe(true);
    } finally {
      await cleanupComparisonRunDirs(run.dirs);
    }
  });
});
