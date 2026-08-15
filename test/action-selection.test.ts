import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const action = Bun.file(join(root, "action.yml"));
const unixSelector = join(root, "scripts", "action", "select-executable.sh");
const nativeSelector = join(root, "scripts", "action", "select-executable.ps1");
const windowsSelector = Bun.file(join(root, "scripts", "action", "select-executable.ps1"));
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace() {
  const path = await mkdtemp(join(tmpdir(), "cuse-action-selection-"));
  fixtures.push(path);
  return path;
}

async function select(override: string, installed: string, cwd: string) {
  const argv = process.platform === "win32"
    ? ["pwsh", "-File", nativeSelector, override, installed, cwd]
    : ["bash", unixSelector, override, installed, cwd];
  const child = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: stdout.trim(), stderr, exitCode };
}

describe("Action executable selection", () => {
  test("a valid relative override selects the current repository binary", async () => {
    const cwd = await workspace();
    const name = process.platform === "win32" ? "cuse.exe" : "cuse";
    const executable = join(cwd, "dist", name);
    await mkdir(join(cwd, "dist"));
    await writeFile(executable, "fixture");
    await chmod(executable, 0o755);

    const result = await select(`dist/${name}`, join(cwd, "unused-release"), cwd);

    expect(result).toEqual({ stdout: await realpath(executable), stderr: "", exitCode: 0 });
  });

  test("an empty override selects the checksum-verified installer result", async () => {
    const cwd = await workspace();
    const executable = join(cwd, process.platform === "win32" ? "installed-cuse.exe" : "installed-cuse");
    await writeFile(executable, "fixture");
    await chmod(executable, 0o755);

    const result = await select("", executable, cwd);

    expect(result).toEqual({ stdout: await realpath(executable), stderr: "", exitCode: 0 });
  });

  test.each([
    [process.platform === "win32" ? "missing.exe" : "missing", "does not exist"],
    ["directory", "is not a file"],
    [process.platform === "win32" ? "plain-file.txt" : "plain-file", "is not executable"],
  ])("rejects a %s override before execution", async (kind, message) => {
    const cwd = await workspace();
    const candidate = join(cwd, kind);
    if (kind === "directory") await mkdir(candidate);
    if (kind.startsWith("plain-file")) await writeFile(candidate, "fixture");

    const result = await select(kind, "", cwd);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(message);
  });

  test("the composite Action skips installers only for an explicit override", async () => {
    const source = await action.text();
    expect(source).toContain("if: runner.os != 'Windows' && inputs.executable-path == ''");
    expect(source).toContain("if: runner.os == 'Windows' && inputs.executable-path == ''");
    expect(source).toContain("CUSE_EXECUTABLE: ${{ steps.select-unix.outputs.path }}");
    expect(source).toContain("CUSE_EXECUTABLE: ${{ steps.select-windows.outputs.path }}");
    expect(source).toContain("scripts/action/install.sh");
    expect(source).toContain("scripts/action/install.ps1");
  });

  test("Windows selection validates file shape and executable extensions", async () => {
    const source = await windowsSelector.text();
    expect(source).toContain("Test-Path -LiteralPath $candidate");
    expect(source).toContain("$item.PSIsContainer");
    expect(source).toContain(".exe");
    expect(source).toContain("is not executable");
  });
});
