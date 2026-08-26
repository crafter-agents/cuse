import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const resolver = join(root, "scripts", "action", "resolve-install-plan.sh");
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
