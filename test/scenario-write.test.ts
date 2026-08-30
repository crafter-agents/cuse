import { describe, expect, test } from "bun:test";
import { parseScenario, type Scenario, type ScenarioStep } from "../src/scenario.ts";
import { buildScenarioDraft, serializeScenario } from "../src/scenario-write.ts";

const steps: ScenarioStep[] = [
  {
    type: "cuse",
    action: "click",
    options: { element: "Save" },
    timeoutMs: 5_000,
  },
  {
    type: "cuse",
    action: "settle",
    timeoutMs: 5_000,
  },
];

describe("scenario writer", () => {
  test("builds a validated draft with steps in input order", () => {
    const scenario = buildScenarioDraft("save a document", steps, {
      vars: { app: "TextEdit" },
    });

    expect(scenario).toEqual({
      version: 1,
      name: "save a document",
      vars: { app: "TextEdit" },
      steps,
    });
    expect(scenario.steps).toEqual(steps);
  });

  test("serializes a draft accepted by the existing parser", () => {
    const serialized = serializeScenario(buildScenarioDraft("save a document", steps));
    const parsed = parseScenario(JSON.parse(serialized));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scenario.steps).toEqual(steps);
  });

  test("rejects a scenario with an unknown top-level key", () => {
    const invalid = {
      ...buildScenarioDraft("save a document", steps),
      unexpected: true,
    } as Scenario;

    expect(() => serializeScenario(invalid)).toThrow(
      "invalid scenario at $.unexpected: unknown key: unexpected",
    );
  });
});
