import { describe, expect, test } from "bun:test";
import { aggregateScenarioRuns } from "../src/cli.ts";
import { runScenario, type CuseInvoker, type Scenario } from "../src/scenario.ts";

const scenario: Scenario = {
  version: 1,
  name: "repeat reliability",
  vars: {},
  defaultTimeoutMs: 100,
  steps: [{ type: "cuse", action: "click" }],
};

async function repeat(times: number, invokeCuse: CuseInvoker) {
  const runs = [];
  for (let iteration = 0; iteration < times; iteration++) {
    runs.push(await runScenario(scenario, { invokeCuse }));
  }
  return aggregateScenarioRuns(scenario, runs);
}

describe("scenario repeat aggregation", () => {
  test("an always-passing step reports a 100% pass rate", async () => {
    const result = await repeat(3, async () => ({ ok: true }));

    expect(result.steps[0]).toEqual({
      phase: "steps",
      index: 0,
      passed: 3,
      failed: 0,
      passRate: 1,
      flakeRate: 0,
      attempts: [1, 1, 1],
    });
  });

  test("a failure on one iteration reports a non-zero fail count", async () => {
    let iteration = 0;
    const result = await repeat(3, async () => {
      iteration++;
      return iteration === 2 ? { ok: false, error: "intermittent failure" } : { ok: true };
    });

    expect(result.steps[0]).toEqual({
      phase: "steps",
      index: 0,
      passed: 2,
      failed: 1,
      passRate: 2 / 3,
      flakeRate: 1 / 3,
      attempts: [1, 1, 1],
    });
  });
});
