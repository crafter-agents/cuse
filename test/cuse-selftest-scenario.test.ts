import { expect, test } from "bun:test";
import { parseScenario } from "../src/scenario.ts";

test("cuse self-test scenario matches the schema", async () => {
  const contents = await Bun.file("scenarios/cuse-selftest.json").text();
  const result = parseScenario(JSON.parse(contents));

  expect(result.ok).toBe(true);
});
