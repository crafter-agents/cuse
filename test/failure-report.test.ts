import { describe, expect, test } from "bun:test";
import {
  buildFailureReport,
  formatFailureReport,
} from "../src/failure-report.ts";
import type {
  ScenarioRunResult,
  ScenarioStepResult,
} from "../src/scenario-run.ts";

function result(
  status: ScenarioRunResult["status"],
  steps: ScenarioStepResult[],
): ScenarioRunResult {
  return {
    status,
    name: "failure report fixture",
    platform: "linux",
    durationMs: 10,
    steps,
  };
}

function execStep(
  overrides: Partial<ScenarioStepResult> = {},
): ScenarioStepResult {
  return {
    phase: "steps",
    index: 0,
    step: { type: "exec", argv: ["false"] },
    status: "failed",
    timedOut: false,
    attempts: 1,
    message: "command exited with status 1",
    ...overrides,
  };
}

describe("failure report", () => {
  test("returns no report for a passed scenario", () => {
    expect(buildFailureReport(result("passed", [
      execStep({ status: "passed", message: undefined }),
    ]))).toBeUndefined();
  });

  test("identifies a failing step by index, phase, and type", () => {
    const report = buildFailureReport(result("failed", [
      execStep({ index: 2 }),
    ]));

    expect(report?.steps).toEqual([{
      index: 2,
      phase: "steps",
      type: "exec",
      status: "failed",
      message: "command exited with status 1",
    }]);
    expect(formatFailureReport(report!)).toContain(
      "steps[2] (exec) failed: command exited with status 1",
    );
  });

  test("distinguishes failures in steps and finally", () => {
    const report = buildFailureReport(result("cleanup_failed", [
      execStep({ index: 0, message: "main failure" }),
      execStep({ phase: "finally", index: 0, message: "cleanup failure" }),
    ]));

    expect(report?.steps.map(({ phase, index }) => ({ phase, index }))).toEqual([
      { phase: "steps", index: 0 },
      { phase: "finally", index: 0 },
    ]);
    expect(formatFailureReport(report!)).toContain("finally[0]");
  });

  test("preserves an assertion failure message verbatim", () => {
    const message = 'assertion eq failed: expected "ready", observed "loading"';
    const report = buildFailureReport(result("failed", [
      execStep({
        step: {
          type: "assert",
          actual: "loading",
          operator: "eq",
          expected: "ready",
        },
        message,
      }),
    ]));

    expect(report?.steps[0]).toMatchObject({
      index: 0,
      phase: "steps",
      type: "assert",
      message,
    });
    expect(formatFailureReport(report!)).toContain(message);
  });

  test("includes present elements as structured diagnostics", () => {
    const presentElements = [
      { role: "button", name: "OK" },
      { role: "button", name: "Cancel" },
    ];
    const report = buildFailureReport(result("failed", [
      execStep({
        step: { type: "cuse", action: "click" },
        cuse: { ok: false, data: { presentElements } },
      }),
    ]));

    expect(report?.steps[0].presentElements).toEqual(presentElements);
    expect(formatFailureReport(report!)).toContain("present: button 'OK', button 'Cancel'");
  });
});
