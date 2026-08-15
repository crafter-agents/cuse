import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const fixtureSource = join(import.meta.dir, "fixtures", "action-cuse-fixture.ts");
let fixtureDir: string;
let executable: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "cuse-action-execution-"));
  executable = join(fixtureDir, process.platform === "win32" ? "cuse-fixture.exe" : "cuse-fixture");
  const build = Bun.spawn([process.execPath, "build", "--compile", fixtureSource, "--outfile", executable], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([new Response(build.stderr).text(), build.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  if (process.platform !== "win32") await chmod(executable, 0o755);
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function parseOutputs(text: string): Record<string, string> {
  const outputs: Record<string, string> = {};
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const multiline = lines[index]!.match(/^([^<]+)<<(.+)$/);
    if (multiline) {
      const value: string[] = [];
      while (lines[++index] !== multiline[2]) value.push(lines[index]!);
      outputs[multiline[1]!] = value.join("\n");
      continue;
    }
    const pair = lines[index]!.match(/^([^=]+)=(.*)$/);
    if (pair) outputs[pair[1]!] = pair[2]!;
  }
  return outputs;
}

async function runScenario(name: string, workingDirectory = fixtureDir) {
  const scenario = join(fixtureDir, `${name}.json`);
  const output = join(fixtureDir, `${name}-${crypto.randomUUID()}.out`);
  await writeFile(scenario, "{}");
  await writeFile(output, "");
  const argv = process.platform === "win32"
    ? ["pwsh", "-File", join(root, "scripts", "action", "execute.ps1"), executable, scenario, workingDirectory, output]
    : ["bash", join(root, "scripts", "action", "execute.sh"), executable, scenario, workingDirectory, output];
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode, outputs: parseOutputs(await readFile(output, "utf8")) };
}

describe("Action scenario execution adapter", () => {
  test("exposes a passing structured result", async () => {
    const result = await runScenario("passed");
    expect(result.exitCode).toBe(0);
    expect(result.outputs.verdict).toBe("passed");
    expect(JSON.parse(result.outputs["result-json"]!)).toMatchObject({
      ok: true, action: "scenario", data: { status: "passed" },
    });
  });

  test("preserves ordinary failure output and exit code", async () => {
    const result = await runScenario("failed");
    expect(result.exitCode).toBe(1);
    expect(result.outputs.verdict).toBe("failed");
    expect(result.outputs["exit-code"]).toBe("1");
    expect(JSON.parse(result.outputs["result-json"]!).data.detail).toBe("deliberate failure");
  });

  test("preserves timeout output and exit code", async () => {
    const result = await runScenario("timed_out");
    expect(result.exitCode).toBe(3);
    expect(result.outputs.verdict).toBe("timed_out");
    expect(result.outputs["exit-code"]).toBe("3");
  });

  test("preserves structured invalid-scenario output and exit code", async () => {
    const result = await runScenario("invalid");
    expect(result.exitCode).toBe(2);
    expect(result.outputs.verdict).toBe("invalid");
    expect(result.outputs["exit-code"]).toBe("2");
    expect(JSON.parse(result.outputs["result-json"]!).error).toBe("invalid scenario fixture");
  });

  test("executes from the configured working directory", async () => {
    const workingDirectory = join(fixtureDir, "nested");
    await mkdir(workingDirectory);
    const result = await runScenario("working-directory", workingDirectory);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.outputs["result-json"]!).data.cwd).toBe(await realpath(workingDirectory));
  });

  test.each(["missing", "malformed"])("identifies %s structured output as an adapter failure", async (name) => {
    const result = await runScenario(name);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("expected one structured scenario result");
    expect(result.outputs.verdict).toBeUndefined();
    expect(result.outputs["exit-code"]).toBeUndefined();
  });
});
