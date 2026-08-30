import {
  parseScenario,
  SCENARIO_SCHEMA_VERSION,
  type Scenario,
  type ScenarioStep,
} from "./scenario.ts";

type ScenarioDraftOptions = {
  vars?: Record<string, unknown>;
  defaultTimeoutMs?: number;
};

function requireValidScenario(input: unknown): Scenario {
  const parsed = parseScenario(input);
  if (!parsed.ok) {
    throw new Error(`invalid scenario at ${parsed.error.path}: ${parsed.error.message}`);
  }
  return parsed.scenario;
}

export function buildScenarioDraft(
  name: string,
  steps: ScenarioStep[],
  opts?: ScenarioDraftOptions,
): Scenario {
  return requireValidScenario({
    version: SCENARIO_SCHEMA_VERSION,
    name,
    vars: opts?.vars ?? {},
    ...(opts?.defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs: opts.defaultTimeoutMs }),
    steps,
  });
}

export function serializeScenario(scenario: Scenario): string {
  const serialized = JSON.stringify(scenario, null, 2);
  requireValidScenario(JSON.parse(serialized));
  return serialized;
}
