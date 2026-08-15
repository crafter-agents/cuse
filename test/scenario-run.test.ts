import { describe, expect, test } from "bun:test";
import {
  runScenario,
  SCENARIO_SCHEMA_VERSION,
  type Scenario,
  type ScenarioPlatform,
  type ScenarioStep,
} from "../src/scenario.ts";
import type { ScenarioStepEvent } from "../src/scenario-run.ts";

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
  test("emits ordered events for a normal failure followed by cleanup", async () => {
    const events: ScenarioStepEvent[] = [];
    const result = await runScenario(scenario([
      exec("process.exit(7)"),
      exec("console.log('not reached')"),
    ], [exec("console.log('cleanup')")]), {
      onStepEvent: (event) => events.push(event),
    });

    expect(events.map((event) => [event.type, event.phase, event.index])).toEqual([
      ["start", "steps", 0],
      ["terminal", "steps", 0],
      ["start", "finally", 0],
      ["terminal", "finally", 0],
    ]);
    expect(events.filter((event) => event.type === "terminal").map((event) => event.result))
      .toEqual(result.steps);
  });

  test("retains partial command output in a timed-out terminal event", async () => {
    const events: ScenarioStepEvent[] = [];
    const result = await runScenario(scenario([{
      type: "wait",
      timeoutMs: 100,
      intervalMs: 100,
      step: exec("process.stdout.write('partial output'); process.exit(1)"),
    }]), {
      onStepEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("timed_out");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "terminal",
      phase: "steps",
      index: 0,
      result: {
        status: "timed_out",
        timedOut: true,
        run: { stdout: "partial output" },
      },
    });
  });

  test("returns unchanged results when the event sink is omitted", async () => {
    const input = scenario([
      exec("console.log('normal')"),
    ], [exec("console.log('cleanup')")]);

    const implicit = await runScenario(input);
    const explicit = await runScenario(input, {});

    expect(explicit).toEqual({ ...implicit, durationMs: explicit.durationMs });
  });

  test("executes successful steps in declared order", async () => {
    const result = await runScenario(scenario([
      exec("console.log('first')"),
      exec("console.log('second')"),
    ]));

    expect(result.status).toBe("passed");
    expect(result.name).toBe("runner test");
    expect(result.platform).toBe(
      ({ darwin: "macos", linux: "linux", win32: "windows" } as Record<string, string>)[process.platform],
    );
    expect(Number.isFinite(result.durationMs)).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
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

    expect(result).toMatchObject({ status: "skipped", name: "runner test", steps: [] });
    expect(Number.isFinite(result.durationMs)).toBe(true);
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

describe("scenario variables and saved step results", () => {
  test("invokes cuse actions and exposes saved results to later steps", async () => {
    const calls: unknown[][] = [];
    const result = await runScenario(scenario([
      { type: "cuse", action: "os", args: ["current"], saveAs: "action" },
      { type: "assert", actual: "${steps.action.data.platform}", operator: "eq", expected: "macos" },
    ]), {
      invokeCuse: async (action, args, options) => {
        calls.push([action, args, options]);
        return { ok: true, data: { platform: "macos" } };
      },
    });

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed"]);
    expect(calls).toEqual([["os", ["current"], undefined]]);
  });

  test("reads saved exec stdout in a later assertion", async () => {
    const result = await runScenario(scenario([
      { ...exec("process.stdout.write('structured flow')"), saveAs: "command" },
      { type: "assert", actual: "${steps.command.stdout}", operator: "eq", expected: "structured flow" },
    ]));

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed"]);
  });

  test("resolves scenario vars into step fields", async () => {
    const input = scenario([
      { type: "assert", actual: "hello ${vars.subject}", operator: "eq", expected: "hello world" },
    ]);
    input.vars = { subject: "world" };

    const result = await runScenario(input);

    expect(result.status).toBe("passed");
  });

  test("reports expected and observed values for failed assertions", async () => {
    const result = await runScenario(scenario([
      { type: "assert", actual: "observed literal", operator: "eq", expected: "expected literal" },
    ]));

    expect(result.status).toBe("failed");
    expect(result.steps[0]!.message).toContain("expected literal");
    expect(result.steps[0]!.message).toContain("observed literal");
  });

  test("fails unset vars without throwing from the runner", async () => {
    const result = await runScenario(scenario([
      { type: "assert", actual: "${vars.absent}", operator: "exists" },
    ]));

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "failed", message: "missing reference: vars.absent" });
  });

  test("fails references to steps that were never saved", async () => {
    const result = await runScenario(scenario([
      { type: "assert", actual: "${steps.never.stdout}", operator: "exists" },
    ]));

    expect(result.status).toBe("failed");
    expect(result.steps[0]).toMatchObject({ status: "failed", message: "missing reference: steps.never.stdout" });
  });

  test("preserves whole-token numeric values from saved assertions", async () => {
    const result = await runScenario(scenario([
      { type: "assert", actual: 7, operator: "eq", expected: 7, saveAs: "measurement" },
      { type: "assert", actual: "${steps.measurement.actual}", operator: "gt", expected: 6 },
    ]));

    expect(result.status).toBe("passed");
  });

  test("accumulates saved values through finally steps in execution order", async () => {
    const result = await runScenario(scenario([
      { ...exec("process.stdout.write('ready')"), saveAs: "setup" },
    ], [
      { type: "assert", actual: "${steps.setup.stdout}", operator: "eq", expected: "ready", saveAs: "checked" },
      { type: "assert", actual: "${steps.checked.passed}", operator: "eq", expected: true },
    ]));

    expect(result.status).toBe("passed");
    expect(result.steps.map((step) => step.status)).toEqual(["passed", "passed", "passed"]);
  });

  test("saves cuse status and delegates wait saves to its nested step", async () => {
    const result = await runScenario(scenario([
      { type: "cuse", action: "launch", args: ["Editor"], saveAs: "action" },
    ], [
      { type: "assert", actual: "${steps.action.status}", operator: "eq", expected: "not_implemented" },
      {
        type: "wait",
        saveAs: "waited",
        step: { type: "assert", actual: 3, operator: "eq", expected: 3 },
      },
      { type: "assert", actual: "${steps.waited.actual}", operator: "eq", expected: 3 },
    ]));

    expect(result.status).toBe("failed");
    expect(result.steps.map((step) => step.status)).toEqual([
      "not_implemented",
      "passed",
      "passed",
      "passed",
    ]);
  });
});
