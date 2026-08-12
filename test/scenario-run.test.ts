import { describe, expect, test } from "bun:test";
import {
  runScenario,
  SCENARIO_SCHEMA_VERSION,
  type Scenario,
  type ScenarioPlatform,
  type ScenarioStep,
} from "../src/scenario.ts";

const scenario = (steps: ScenarioStep[], cleanup: ScenarioStep[] = []): Scenario => ({
  version: SCENARIO_SCHEMA_VERSION,
  name: "runner test",
  vars: {},
  defaultTimeoutMs: 1_000,
  steps,
  finally: cleanup,
});

const exec = (script: string, timeoutMs?: number): ScenarioStep => ({
  type: "exec",
  argv: [process.execPath, "-e", script],
  timeoutMs,
});

describe("scenario execution lifecycle", () => {
  test("executes successful steps in declared order", async () => {
    const result = await runScenario(scenario([
      exec("console.log('first')"),
      exec("console.log('second')"),
    ]));

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.run?.stdout.trim())).toEqual(["first", "second"]);
    expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed"]);
  });

  test("stops after a required failure and runs every cleanup step", async () => {
    const result = await runScenario(scenario([
      exec("process.exit(7)"),
      exec("console.log('not reached')"),
    ], [exec("console.log('cleanup one')"), exec("console.log('cleanup two')")]));

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.phase)).toEqual(["steps", "finally", "finally"]);
    expect(result.steps.map((step) => step.run?.stdout.trim())).toEqual(["", "cleanup one", "cleanup two"]);
  });

  test("reports a normal step timeout and still runs cleanup", async () => {
    const result = await runScenario(scenario([
      exec("await Bun.sleep(500)", 20),
    ], [exec("console.log('clean')")]));

    expect(result.status).toBe("timed_out");
    expect(result.steps[0]).toMatchObject({ status: "timed_out", timedOut: true });
    expect(result.steps[1]).toMatchObject({ phase: "finally", status: "passed" });
  });

  test("skips an excluded platform without running steps or cleanup", async () => {
    const platforms = (["macos", "linux", "windows"] as ScenarioPlatform[])
      .filter((platform) => platform !== ({ darwin: "macos", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform]);
    const input = scenario([exec("process.exit(1)")], [exec("process.exit(1)")]);
    input.platforms = [platforms[0]!];

    const result = await runScenario(input);

    expect(result).toEqual({ status: "skipped", steps: [] });
  });

  test("cleanup failure takes precedence over a normal failure", async () => {
    const result = await runScenario(scenario([
      exec("process.exit(2)"),
    ], [exec("process.exit(3)")]));

    expect(result.status).toBe("cleanup_failed");
    expect(result.steps.map((step) => step.status)).toEqual(["failed", "failed"]);
  });

  test("marks cuse steps not implemented and never passes the scenario", async () => {
    const result = await runScenario(scenario([
      { type: "cuse", action: "launch", args: ["Editor"] },
    ]));

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "not_implemented", timedOut: false });
  });

  test("records command spawn errors as failed attempts", async () => {
    const result = await runScenario(scenario([
      { type: "exec", argv: ["/command/that/does/not/exist"] },
    ]));

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "failed", timedOut: false, attempts: 1 });
    expect(result.steps[0]!.message?.length).toBeGreaterThan(0);
  });

  test("evaluates literal assertions and retries waits until their deadline", async () => {
    const assertions = await runScenario(scenario([
      { type: "assert", actual: [1, 2], operator: "contains", expected: 2 },
      { type: "assert", actual: 4, operator: "gte", expected: 4 },
    ]));
    const waited = await runScenario(scenario([
      {
        type: "wait",
        timeoutMs: 20,
        intervalMs: 5,
        step: { type: "assert", actual: false, operator: "eq", expected: true },
      },
    ]));

    expect(assertions.status).toBe("passed");
    expect(waited.status).toBe("timed_out");
    expect(waited.steps[0]!.attempts).toBeGreaterThan(1);
  });
});
