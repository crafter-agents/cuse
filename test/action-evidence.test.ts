import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function prepare(
  name: string,
  status: string | undefined,
  exitCode: string,
  steps: unknown[] = [{ phase: "steps", index: 0, step: { type: "launch" }, status: "passed", env: { SAFE_NAME: "secret value" } }],
) {
  const runnerTemp = await mkdtemp(join(tmpdir(), "cuse-action-evidence-"));
  temporaryDirectories.push(runnerTemp);
  const output = join(runnerTemp, "output.txt");
  const summary = join(runnerTemp, "summary.md");
  await writeFile(output, "");
  await writeFile(summary, "");
  const result = status === undefined ? "not-json" : JSON.stringify({
    ok: status === "passed",
    action: "scenario",
    data: { status, steps },
  });
  const child = Bun.spawn([
    process.execPath,
    join(root, "scripts", "action", "prepare-evidence.mjs"),
    runnerTemp,
    name,
    result,
    exitCode,
    output,
    summary,
  ], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const evidencePath = (await readFile(output, "utf8")).match(/^evidence-path=(.+)$/m)?.[1];
  expect(evidencePath).toBeDefined();
  return { runnerTemp, evidencePath: evidencePath!, summary: await readFile(summary, "utf8") };
}

describe("Action evidence preparation", () => {
  test.each([
    ["passed", "0"],
    ["failed", "1"],
    ["timed_out", "3"],
  ])("prepares result and summary for %s", async (status, exitCode) => {
    const prepared = await prepare("scenario-run", status, exitCode);
    expect(relative(prepared.runnerTemp, prepared.evidencePath)).toBe(join("cuse-evidence", "scenario-run"));
    expect(prepared.summary).toContain(`| Status | \`${status}\` |`);
    expect(prepared.summary).toContain(`| Exit code | \`${exitCode}\` |`);
    if (status === "passed") expect(prepared.summary).not.toContain("### Failing steps");
    const stored = await readFile(join(prepared.evidencePath, "result.json"), "utf8");
    expect(JSON.parse(stored).data.steps[0].env.SAFE_NAME).toBe("[REDACTED]");
  });

  test("lists only non-passed scenario steps in a failed summary", async () => {
    const prepared = await prepare("failed-scenario", "failed", "1", [
      { phase: "setup", index: 0, step: { type: "launch" }, status: "passed" },
      { phase: "steps", index: 1, step: { type: "assert" }, status: "failed", message: "assertion eq failed: expected \"ready\", observed \"loading\"", cuse: { data: { presentElements: [{ role: "button", name: "OK" }, { role: "button", name: "Cancel" }] } } },
      { phase: "teardown", index: 0, step: { type: "close" }, status: "skipped" },
    ]);

    expect(prepared.summary).toContain("### Failing steps");
    expect(prepared.summary).toContain('steps[1] (assert) failed: assertion eq failed: expected "ready", observed "loading"');
    expect(prepared.summary).toContain("present: button 'OK', button 'Cancel'");
    expect(prepared.summary).toContain("teardown[0] (close) skipped");
    expect(prepared.summary).not.toContain("setup[0] (launch) passed");
  });

  test("normalizes an unsafe evidence name inside runner temp", async () => {
    const prepared = await prepare("../../unsafe\\name", "passed", "0");
    expect(relative(prepared.runnerTemp, prepared.evidencePath)).toBe(join("cuse-evidence", "unsafe-name"));
    expect(relative(prepared.runnerTemp, prepared.evidencePath)).not.toStartWith("..");
  });

  test("summarizes adapter failure and still prepares an evidence path", async () => {
    const prepared = await prepare("adapter", undefined, "");
    expect(prepared.summary).toContain("| Status | `adapter_failure` |");
    expect(prepared.summary).toContain("Gap: The execution adapter did not provide");
    expect(await readFile(join(prepared.evidencePath, "adapter-error.txt"), "utf8"))
      .toContain("did not produce a valid structured scenario result");
  });
});
