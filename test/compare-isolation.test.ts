import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  cleanupComparisonRunDirs,
  createComparisonRunDirs,
  type ComparisonRunDirs,
} from "../src/compare-isolation.ts";

function paths(dirs: ComparisonRunDirs): string[] {
  return [
    dirs.baseline.workDir,
    dirs.baseline.evidenceDir,
    dirs.candidate.workDir,
    dirs.candidate.evidenceDir,
  ];
}

describe("comparison run directory isolation", () => {
  test("creates distinct directories across comparison runs", async () => {
    const first = await createComparisonRunDirs();
    const second = await createComparisonRunDirs();
    try {
      const allPaths = [...paths(first), ...paths(second)];
      expect(new Set(allPaths).size).toBe(8);
    } finally {
      await cleanupComparisonRunDirs(first);
      await cleanupComparisonRunDirs(second);
    }
  });

  test("creates every returned directory on disk", async () => {
    const dirs = await createComparisonRunDirs();
    try {
      for (const path of paths(dirs)) {
        expect(existsSync(path)).toBe(true);
        expect(statSync(path).isDirectory()).toBe(true);
      }
    } finally {
      await cleanupComparisonRunDirs(dirs);
    }
  });

  test("keeps baseline files out of the candidate work directory", async () => {
    const dirs = await createComparisonRunDirs();
    const sentinel = "contamination-sentinel";
    try {
      await writeFile(join(dirs.baseline.workDir, sentinel), "baseline only");
      expect(existsSync(join(dirs.candidate.workDir, sentinel))).toBe(false);
    } finally {
      await cleanupComparisonRunDirs(dirs);
    }
  });

  test("removes both comparison roots", async () => {
    const dirs = await createComparisonRunDirs();
    const baselineRoot = dirname(dirs.baseline.workDir);
    const candidateRoot = dirname(dirs.candidate.workDir);

    await cleanupComparisonRunDirs(dirs);

    expect(existsSync(baselineRoot)).toBe(false);
    expect(existsSync(candidateRoot)).toBe(false);
  });
});
