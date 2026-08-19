import {
  compareScenarioResults,
  type ComparisonFieldPath,
  type ComparisonInput,
} from "./compare.ts";
import {
  createComparisonRunDirs,
  type ComparisonRunDirs,
} from "./compare-isolation.ts";
import {
  buildComparisonReport,
  type ComparisonReport,
} from "./compare-report.ts";
import type { ScenarioRunResult } from "./scenario-run.ts";
import { runSetup, type SetupCommand } from "./setup-adapter.ts";

export type ComparisonManifest = {
  scenario: string;
  baseline: SetupCommand;
  candidate: SetupCommand;
  fields?: readonly ComparisonFieldPath[];
};

export type ScenarioSideRunner = (
  dirs: { workDir: string; evidenceDir: string },
) => Promise<ScenarioRunResult>;

export async function runComparison(
  manifest: ComparisonManifest,
  runners: { baseline: ScenarioSideRunner; candidate: ScenarioSideRunner },
  setupTimeoutMs?: number,
): Promise<{ report: ComparisonReport; dirs: ComparisonRunDirs }> {
  const dirs = await createComparisonRunDirs();

  const baselineSetup = await runSetup(manifest.baseline, setupTimeoutMs);
  const baselineInput: ComparisonInput = "ok" in baselineSetup
    ? await runners.baseline(dirs.baseline)
    : baselineSetup;

  const candidateSetup = await runSetup(manifest.candidate, setupTimeoutMs);
  const candidateInput: ComparisonInput = "ok" in candidateSetup
    ? await runners.candidate(dirs.candidate)
    : candidateSetup;
  const comparison = compareScenarioResults(
    baselineInput,
    candidateInput,
    manifest.fields ?? [],
  );

  return { report: buildComparisonReport(comparison), dirs };
}
