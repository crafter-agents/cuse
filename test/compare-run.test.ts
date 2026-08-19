import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

  test("runs each side's own setup immediately before its own run, not before the other side's run", async () => {
    const order: string[] = [];
    const scratch = await mkdtemp(join(tmpdir(), "cuse-compare-order-test-"));
    const stateFile = join(scratch, "state.txt");
    // sh -c strips unquoted backslashes, so a raw Windows path mangles into
    // a flattened filename. Use a posix-slash version for the shell command
    // only; every readFile below keeps the native-separator stateFile path.
    const shPath = stateFile.split(sep).join("/");
    const baselineSetup = {
      argv: ["sh", "-c", `echo baseline > ${shPath}`],
      cwd: scratch,
    };
    const candidateSetup = {
      argv: ["sh", "-c", `echo candidate > ${shPath}`],
      cwd: scratch,
    };

    try {
      const run = await runComparison(
        { scenario: "scenario.json", baseline: baselineSetup, candidate: candidateSetup },
        {
          baseline: async () => {
            order.push("run:baseline");
            // If candidate's setup had already run (the bug), this would read "candidate".
            const observed = (await readFile(stateFile, "utf8")).trim();
            expect(observed).toBe("baseline");
            return result("failed");
          },
          candidate: async () => {
            order.push("run:candidate");
            const observed = (await readFile(stateFile, "utf8")).trim();
            expect(observed).toBe("candidate");
            return result("passed");
          },
        },
      );

      expect(order).toEqual(["run:baseline", "run:candidate"]);
      await cleanupComparisonRunDirs(run.dirs);
    } finally {
      await rm(scratch, { recursive: true, force: true });
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
