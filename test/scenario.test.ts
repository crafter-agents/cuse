import { describe, expect, test } from "bun:test";
import { parseScenario, SCENARIO_SCHEMA_VERSION } from "../src/scenario.ts";

const minimal = () => ({
  version: SCENARIO_SCHEMA_VERSION,
  name: "open an app",
  vars: {},
  steps: [{ type: "cuse", action: "launch", args: ["TextEdit"], timeoutMs: 5_000 }],
});

describe("scenario schema", () => {
  test("parses a valid minimal scenario", () => {
    const result = parseScenario(minimal());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.scenario.steps[0]?.type).toBe("cuse");
  });

  test("accepts a bounded default and all five step types", () => {
    const result = parseScenario({
      version: 1,
      name: "complete shape",
      platforms: ["macos", "linux", "windows"],
      vars: { app: "Editor" },
      defaultTimeoutMs: 10_000,
      steps: [
        { type: "cuse", action: "launch", args: ["${vars.app}"], saveAs: "launch" },
        { type: "exec", argv: ["printf", "%s", "ok"], saveAs: "output" },
        { type: "json", path: "evidence/result.json", saveAs: "document" },
        { type: "assert", actual: "${steps.output.stdout}", operator: "eq", expected: "ok" },
        { type: "wait", intervalMs: 100, step: { type: "assert", actual: true, operator: "eq", expected: true } },
      ],
      finally: [{ type: "exec", argv: ["killall", "Editor"] }],
    });
    expect(result.ok).toBe(true);
  });

  test.each([
    [{ type: "json" }, "path must be a non-empty string"],
    [{ type: "json", path: 42 }, "path must be a non-empty string"],
    [{ type: "json", path: "" }, "path must be a non-empty string"],
  ] as const)("rejects an invalid JSON step path %#", (step, message) => {
    const result = parseScenario({
      version: 1,
      name: "invalid JSON step",
      vars: {},
      defaultTimeoutMs: 1_000,
      steps: [step],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_scenario", path: "$.steps[0].path", message },
    });
  });

  test("rejects unknown JSON step keys", () => {
    const result = parseScenario({
      version: 1,
      name: "invalid JSON step",
      vars: {},
      defaultTimeoutMs: 1_000,
      steps: [{ type: "json", path: "result.json", format: "json" }],
    });

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid_scenario", path: "$.steps[0].format", message: "unknown key: format" },
    });
  });

  test("rejects an unknown key", () => {
    expect(parseScenario({ ...minimal(), surprise: true })).toEqual({
      ok: false,
      error: { code: "invalid_scenario", path: "$.surprise", message: "unknown key: surprise" },
    });
  });

  test("rejects an unsupported exec stdout format", () => {
    const result = parseScenario({
      version: 1,
      name: "invalid stdout format",
      vars: {},
      defaultTimeoutMs: 1_000,
      steps: [{ type: "exec", argv: ["printf", "ok"], stdout: "yaml" }],
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: "invalid_scenario",
        path: "$.steps[0].stdout",
        message: "stdout must be \"text\" or \"json\"",
      },
    });
  });

  test("rejects a step without a timeout or bounded default", () => {
    const document = minimal();
    delete (document.steps[0] as { timeoutMs?: number }).timeoutMs;
    const result = parseScenario(document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.steps[0].timeoutMs");
  });

  test("rejects a recursive scenario invocation", () => {
    const document = minimal();
    document.steps[0]!.action = "scenario";
    const result = parseScenario(document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cannot invoke another scenario");
  });

  test("rejects invalid interpolation syntax", () => {
    const document = minimal();
    document.steps[0]!.args = ["${vars.app"];
    const result = parseScenario(document);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.steps[0].args[0]");
  });

  test("rejects an unsupported platform", () => {
    const result = parseScenario({ ...minimal(), platforms: ["freebsd"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("unsupported platform: freebsd");
  });
});
