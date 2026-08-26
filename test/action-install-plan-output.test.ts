import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const action = join(import.meta.dir, "..", "action.yml");

function stepBlock(source: string, id: string): string {
  const start = source.indexOf(`    - id: ${id}`);
  const end = source.indexOf("\n    - id:", start + 1);
  return source.slice(start, end === -1 ? undefined : end);
}

describe("Action install plan output", () => {
  test("resolves and exposes the plan before installation on Unix", async () => {
    const source = await readFile(action, "utf8");
    const step = stepBlock(source, "resolve-plan-unix");

    expect(step).toContain("resolve-install-plan.sh");
    expect(step).toContain("GITHUB_OUTPUT");
    expect(step).toContain("GITHUB_STEP_SUMMARY");
    expect(source.indexOf("    - id: resolve-plan-unix")).toBeLessThan(source.indexOf("    - id: install-unix"));
  });

  test("resolves and exposes the plan before installation on Windows", async () => {
    const source = await readFile(action, "utf8");
    const step = stepBlock(source, "resolve-plan-windows");

    expect(step).toContain("resolve-install-plan.ps1");
    expect(step).toContain("GITHUB_OUTPUT");
    expect(step).toContain("GITHUB_STEP_SUMMARY");
    expect(source.indexOf("    - id: resolve-plan-windows")).toBeLessThan(source.indexOf("    - id: install-windows"));
  });

  test("publishes either runner plan as a top-level output", async () => {
    const source = await readFile(action, "utf8");
    const output = source.match(/  install-plan-json:\n(?:    .+\n)+/)?.[0];

    expect(output).toContain("value:");
    expect(output).toContain("steps.resolve-plan-unix.outputs.plan-json");
    expect(output).toContain("steps.resolve-plan-windows.outputs.plan-json");
  });
});
