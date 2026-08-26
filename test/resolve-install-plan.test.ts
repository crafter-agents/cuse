import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const resolver = join(root, "scripts", "action", "resolve-install-plan.sh");
const powershellResolver = join(root, "scripts", "action", "resolve-install-plan.ps1");
const powershellInstaller = join(root, "scripts", "action", "install.ps1");
const assetContract = join(root, "scripts", "action", "assets.tsv");

type InstallPlan = {
  schemaVersion: number;
  supported: boolean;
  runner: { os: string; arch: string };
  strategy: "override" | "native" | "unsupported";
  requestedArch: string;
  resolvedArch: string | null;
  asset: string | null;
  executablePath: string | null;
  remediation: { kind: string; message: string } | null;
};

async function resolve(os: string, arch: string, override?: string): Promise<InstallPlan> {
  const command = ["bash", resolver, os, arch];
  if (override !== undefined) command.push(override);

  const process = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  return JSON.parse(stdout) as InstallPlan;
}

describe("install-plan resolver", () => {
  test("PowerShell resolver mirrors the install-plan contract", async () => {
    const source = await readFile(powershellResolver, "utf8");

    for (const field of [
      "schemaVersion",
      "supported",
      "runner",
      "strategy",
      "requestedArch",
      "resolvedArch",
      "asset",
      "executablePath",
      "remediation",
    ]) {
      expect(source).toContain(`"${field}"`);
    }
    expect(source).toContain('"native"');
    expect(source).toContain('"unsupported"');
    expect(source).toContain('"executable-path"');
    expect(source).toContain('Join-Path $PSScriptRoot "assets.tsv"');
    expect(source).toContain("ConvertTo-Json -Depth 3 -Compress");
  });

  test("PowerShell installer consumes the resolver plan", async () => {
    const source = await readFile(powershellInstaller, "utf8");

    expect(source).toContain('Join-Path $PSScriptRoot "resolve-install-plan.ps1"');
    expect(source).toContain("ConvertFrom-Json");
    expect(source).toContain("$plan.supported");
    expect(source).toContain("$plan.asset");
    expect(source).not.toContain("Import-Csv");
  });

  test("maps every published runner asset to a native plan", async () => {
    const rows = (await readFile(assetContract, "utf8")).trim().split(/\r?\n/).map((row) => row.split("\t"));

    for (const [os, arch, asset] of rows) {
      const plan = await resolve(os, arch);
      expect(plan).toEqual({
        schemaVersion: 1,
        supported: true,
        runner: { os, arch },
        strategy: "native",
        requestedArch: arch,
        resolvedArch: arch,
        asset,
        executablePath: null,
        remediation: null,
      });
    }
  });

  test("reports Windows ARM64 as unsupported with remediation", async () => {
    const plan = await resolve("Windows", "ARM64");

    expect(plan.supported).toBe(false);
    expect(plan.strategy).toBe("unsupported");
    expect(plan.remediation?.kind).toBe("executable-path");
  });

  test("reports an unknown OS as unsupported", async () => {
    const plan = await resolve("Plan9", "ARM64");

    expect(plan.supported).toBe(false);
    expect(plan.strategy).toBe("unsupported");
  });

  test("uses a non-empty executable override for any runner", async () => {
    const plan = await resolve("Linux", "X64", "/tmp/my-cuse");

    expect(plan.strategy).toBe("override");
    expect(plan.supported).toBe(true);
    expect(plan.executablePath).toBe("/tmp/my-cuse");
    expect(plan.asset).toBeNull();
  });
});
