import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeFile } from "../../src/probes/file.ts";

describe("file probe", () => {
  let fixtureDirectory: string;
  let filePath: string;
  let directoryPath: string;
  let symlinkPath: string;
  const contents = "probe fixture";

  beforeAll(async () => {
    fixtureDirectory = await mkdtemp(join(tmpdir(), "cuse-file-probe-"));
    filePath = join(fixtureDirectory, "fixture.txt");
    directoryPath = join(fixtureDirectory, "directory");
    symlinkPath = join(fixtureDirectory, "fixture-link");
    await writeFile(filePath, contents);
    await mkdir(directoryPath);
    await symlink(filePath, symlinkPath);
  });

  afterAll(async () => {
    await rm(fixtureDirectory, { recursive: true, force: true });
  });

  test("reports a regular file", async () => {
    const result = await probeFile(filePath, "linux");

    expect(result.found).toBe(true);
    expect(result.status).toBe("found");
    expect(result.normalized?.type).toBe("file");
    expect(result.normalized?.size).toBe(Buffer.byteLength(contents));
    expect(result.normalized?.path).toBe(filePath);
  });

  test("reports a directory without a size", async () => {
    const result = await probeFile(directoryPath, "linux");

    expect(result.found).toBe(true);
    expect(result.normalized?.type).toBe("directory");
    expect(result.normalized?.size).toBeNull();
  });

  test("reports a symbolic link without resolving it", async () => {
    const result = await probeFile(symlinkPath, "linux");

    expect(result.found).toBe(true);
    expect(result.normalized?.type).toBe("symlink");
  });

  test("reports a missing path as not found", async () => {
    const result = await probeFile(join(fixtureDirectory, "missing"), "linux");

    expect(result.status).toBe("not-found");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
  });

  test("reports a path with a non-directory component as unavailable", async () => {
    const result = await probeFile(join(filePath, "nested"), "linux");

    expect(result.status).toBe("unavailable");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
