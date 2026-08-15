import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const installer = join(root, "scripts", "action", "install.sh");
const assetContract = join(root, "scripts", "action", "assets.tsv");
let fixtureDir: string;
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(join(tmpdir(), "cuse-action-test-"));
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const name = new URL(request.url).pathname.slice(1);
      const file = Bun.file(join(fixtureDir, name));
      return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  server.stop(true);
  await rm(fixtureDir, { recursive: true, force: true });
});

async function install(os: string, arch: string, destination: string) {
  const process = Bun.spawn(["bash", installer, "v-test", os, arch, destination], {
    env: { ...Bun.env, CUSE_RELEASE_BASE_URL: baseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).arrayBuffer(),
    new Response(process.stderr).arrayBuffer(),
    process.exited,
  ]);
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
  };
}

describe("release installer", () => {
  test("the shared contract maps every published runner asset", async () => {
    const rows = (await readFile(assetContract, "utf8")).trim().split(/\r?\n/).map((row) => row.split("\t"));
    expect(rows).toEqual([
      ["macOS", "ARM64", "cuse-macos-arm64"],
      ["macOS", "X64", "cuse-macos-x64"],
      ["Linux", "ARM64", "cuse-linux-arm64"],
      ["Linux", "X64", "cuse-linux-x64"],
      ["Windows", "X64", "cuse-windows-x64.exe"],
    ]);
  });

  test("rejects an unsupported runner before downloading", async () => {
    const result = await install("Windows", "ARM64", join(fixtureDir, "unsupported"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("unsupported runner: Windows/ARM64");
  });

  test("exposes an executable only after its checksum matches", async () => {
    const contents = "fixture executable";
    const asset = "cuse-linux-x64";
    const checksum = createHash("sha256").update(contents).digest("hex");
    await writeFile(join(fixtureDir, asset), contents);
    await writeFile(join(fixtureDir, "SHA256SUMS"), `${checksum}  ${asset}\n`);
    const destination = join(fixtureDir, "matching");

    const result = await install("Linux", "X64", destination);

    expect(result.exitCode).toBe(0);
    const installed = result.stdout.toString().trim();
    expect(installed.split(/[\\/]/).at(-1)).toBe("cuse");
    expect(await Bun.file(join(destination, "cuse")).text()).toBe(contents);
  });

  test("a checksum mismatch leaves no executable", async () => {
    const asset = "cuse-macos-arm64";
    await writeFile(join(fixtureDir, asset), "tampered");
    await writeFile(join(fixtureDir, "SHA256SUMS"), `${"0".repeat(64)}  ${asset}\n`);
    const destination = join(fixtureDir, "mismatch");

    const result = await install("macOS", "ARM64", destination);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(`checksum mismatch for ${asset}`);
    expect(await Bun.file(join(destination, "cuse")).exists()).toBe(false);
  });
});
