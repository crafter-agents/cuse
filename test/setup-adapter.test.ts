import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareScenarioResults } from "../src/compare.ts";
import { runSetup } from "../src/setup-adapter.ts";

describe("setup adapter", () => {
  test("success honors cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "cuse-setup-test-"));
    try {
      const result = await runSetup({
        argv: ["sh", "-c", "echo ok > marker.txt"],
        cwd,
      });

      expect(result).toEqual({ ok: true });
      expect(await Bun.file(join(cwd, "marker.txt")).exists()).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("failure reports the command's own message", async () => {
    const result = await runSetup({
      argv: ["sh", "-c", "echo 'build failed: missing dependency' >&2; exit 1"],
      cwd: ".",
    });

    expect(result).toEqual({
      kind: "setup_failed",
      message: "build failed: missing dependency",
    });
  });

  test("a hung setup command is killed rather than waited on", async () => {
    const started = Date.now();
    const result = await runSetup({ argv: ["sleep", "30"], cwd: "." }, 300);

    expect(result).toEqual({
      kind: "setup_failed",
      message: "sleep did not finish within 300ms and was killed",
    });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  test("an empty setup command is rejected before spawning", async () => {
    expect(await runSetup({ argv: [], cwd: "." })).toEqual({
      kind: "setup_failed",
      message: "setup command is empty",
    });
  });

  test("setup failure passes directly into scenario comparison", async () => {
    const baselineDir = await mkdtemp(join(tmpdir(), "cuse-setup-test-baseline-"));
    const candidateDir = await mkdtemp(join(tmpdir(), "cuse-setup-test-candidate-"));
    try {
      const baseline = await runSetup({ argv: ["sh", "-c", "exit 1"], cwd: baselineDir });
      const candidate = await runSetup({ argv: ["sh", "-c", "exit 0"], cwd: candidateDir });

      expect(candidate).toEqual({ ok: true });
      const comparison = compareScenarioResults(
        baseline,
        "ok" in candidate ? undefined : candidate,
      );
      expect(comparison.verdict).toEqual({
        kind: "baseline_or_candidate_setup_failed",
        sides: ["baseline"],
      });
    } finally {
      await rm(baselineDir, { recursive: true, force: true });
      await rm(candidateDir, { recursive: true, force: true });
    }
  });
});
