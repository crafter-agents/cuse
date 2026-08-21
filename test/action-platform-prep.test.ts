import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const prepare = join(root, "scripts", "action", "prepare-platform.sh");
let fixtureDir: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "cuse-platform-prep-"));
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

async function scenario(name: string, steps: unknown[]) {
  const path = join(fixtureDir, `${name}.json`);
  await writeFile(path, JSON.stringify({ version: 1, name, vars: {}, defaultTimeoutMs: 1000, steps }));
  return path;
}

async function run(os: string, path: string, display = "automatic", accessibility = "false") {
  const envFile = join(fixtureDir, "github-env");
  const child = Bun.spawn(["bash", prepare, os, path, display, accessibility, envFile], {
    env: { ...Bun.env, CUSE_ACTION_DRY_RUN: "true", DISPLAY: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("Action platform preparation", () => {
  test("a headless Linux scenario avoids Xvfb", async () => {
    const path = await scenario("headless", [
      { type: "exec", argv: ["printf", "ok"] },
      { type: "assert", actual: true, operator: "eq", expected: true },
    ]);
    const result = await run("Linux", path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("display-required=false");
    expect(result.stdout).toContain("packages=none start-xvfb=false");
  }, 15_000);

  test("a display action requests bounded Linux display facilities", async () => {
    const path = await scenario("display", [{ type: "cuse", action: "capture", args: ["out.png"] }]);
    const result = await run("Linux", path);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("display-required=true");
    expect(result.stdout).toContain("packages=xvfb x11-apps start-xvfb=true");
  }, 15_000);

  test("invalid preparation input is rejected before mutation", async () => {
    const path = await scenario("invalid", []);
    const result = await run("Linux", path, "sometimes");
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("invalid linux-display 'sometimes'");
    expect(result.stdout).not.toContain("plan:");
  }, 15_000);

  test("Linux accessibility setup is opt-in and observable", async () => {
    const path = await scenario("accessibility", [{ type: "cuse", action: "elements", args: ["Editor"] }]);
    const implicit = await run("Linux", path);
    const explicit = await run("Linux", path, "automatic", "true");
    expect(implicit.stdout).toContain("linux-accessibility=false");
    expect(implicit.stdout).toContain("AT-SPI will not be installed");
    expect(explicit.stdout).toContain("linux-accessibility=true");
    expect(explicit.stdout).toContain("at-spi2-core python3-pyatspi dbus-x11");
  }, 15_000);

  test("non-Linux preparation preserves the interactive session", async () => {
    const path = await scenario("macos", [{ type: "cuse", action: "capture" }]);
    const result = await run("macOS", path, "always", "true");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("uses its current interactive session");
    expect(result.stdout).toContain("no display service was changed");
    expect(result.stdout).not.toContain("plan:");
  }, 15_000);
});
