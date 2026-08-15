import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const workflowPath = join(root, ".github", "workflows", "action-portless-fixtures.yml");
const linuxPath = join(root, "scenarios", "action-portless-linux.json");
const windowsPath = join(root, "scenarios", "action-portless-windows.json");
const listener = join(root, "scenarios", "fixtures", "action-portless-listener.sh");

describe("hosted Action fixture contracts", () => {
  test("the workflow builds and exercises both hosted runner cells", async () => {
    const workflow = await Bun.file(workflowPath).text();
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("os: windows-latest");
    expect(workflow).toContain("os: ubuntu-latest");
    expect(workflow).toContain("bun run build");
    expect(workflow).toContain("uses: ./");
    expect(workflow).toContain("executable-path: ${{ steps.binary.outputs.path }}");
    expect(workflow).toContain("if: always() && runner.os == 'Windows'");
    expect(workflow).toContain("if: always() && runner.os == 'Linux'");
    expect(workflow).toContain("uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
    expect(workflow).toContain("if: always()");

    const externalUses = [...workflow.matchAll(/^\s*(?:-\s+)?uses: ([^@\s]+)@([^\s]+)/gm)]
      .filter((match) => match[1] !== "./");
    expect(externalUses.length).toBe(3);
    for (const [, , revision] of externalUses) expect(revision).toMatch(/^[0-9a-f]{40}$/);
    expect(workflow).not.toContain("secrets.");
  });

  test("Windows declaratively inspects and asserts the disposable task", async () => {
    const scenario = await Bun.file(windowsPath).json();
    const inspect = scenario.steps.find((step: { type: string }) => step.type === "cuse");
    const assertion = scenario.steps.find((step: { type: string }) => step.type === "assert");
    expect(scenario.platforms).toEqual(["windows"]);
    expect(scenario.steps[0].saveAs).toBe("createdTask");
    expect(inspect).toMatchObject({ action: "inspect", args: ["scheduled-task"], saveAs: "task" });
    expect(assertion).toMatchObject({
      actual: "${steps.task.data.normalized.executionTimeLimit}",
      operator: "eq",
      expected: "PT7M",
    });
    expect(scenario.finally[0].argv.join(" ")).toContain("Unregister-ScheduledTask");
  });

  test("Linux declaratively inspects and asserts the bounded listener", async () => {
    const scenario = await Bun.file(linuxPath).json();
    const inspect = scenario.steps.find((step: { type: string }) => step.type === "cuse");
    const assertion = scenario.steps.find((step: { type: string }) => step.type === "assert");
    expect(scenario.platforms).toEqual(["linux"]);
    expect(scenario.steps[0]).toMatchObject({ type: "exec", saveAs: "listener" });
    expect(inspect).toMatchObject({ action: "inspect", args: ["port"], saveAs: "port" });
    expect(assertion).toMatchObject({
      actual: "${steps.port.data.normalized.state}",
      operator: "eq",
      expected: "LISTEN",
    });
    expect(scenario.finally[0].argv).toContain("stop");
  });

  test.skipIf(process.platform === "win32")("the Linux fixture returns without leaking its listener pipes", async () => {
    const runnerTemp = await mkdtemp(join(tmpdir(), "cuse-action-listener-"));
    const env = { ...Bun.env, RUNNER_TEMP: runnerTemp, GITHUB_RUN_ID: "test", GITHUB_RUN_ATTEMPT: "1" };
    try {
      const started = Bun.spawn(["bash", listener, "start", "0"], {
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const deadline = Bun.sleep(3_000).then(() => "timeout" as const);
      expect(await Promise.race([started.exited, deadline])).toBe(0);
      expect(await new Response(started.stdout).text()).toMatch(/^\d+$/);
    } finally {
      const stopped = Bun.spawn(["bash", listener, "stop"], { env });
      expect(await stopped.exited).toBe(0);
      await rm(runnerTemp, { recursive: true, force: true });
    }
  });
});
