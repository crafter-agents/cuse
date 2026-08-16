import type {
  ComparisonVerdict,
  FieldComparison,
  ScenarioComparison,
} from "./compare.ts";

export type ComparisonReport = {
  verdict: ComparisonVerdict;
  headline: string;
  changedFields: FieldComparison[];
  unchangedFields: FieldComparison[];
  missingEvidence: string[];
};

function headlineFor(verdict: ComparisonVerdict): string {
  switch (verdict.kind) {
    case "reproduced_and_fixed":
      return "Baseline reproduced the failure; candidate fixed it.";
    case "reproduced_and_still_failing":
      return "Baseline reproduced the failure; candidate still fails.";
    case "baseline_unexpectedly_passes":
      return `Baseline did not reproduce the failure (observed status: ${verdict.observedStatus}); no fix can be claimed.`;
    case "baseline_or_candidate_setup_failed":
      return `Setup failed for: ${verdict.sides.join(", ")}; no scenario evidence was collected.`;
    case "inconclusive_missing_evidence":
      return `Comparison is inconclusive; missing evidence: ${verdict.missing.join(", ")}.`;
  }
}

export function buildComparisonReport(comparison: ScenarioComparison): ComparisonReport {
  const changedFields: FieldComparison[] = [];
  const unchangedFields: FieldComparison[] = [];

  for (const field of comparison.fields) {
    (field.equal ? unchangedFields : changedFields).push(field);
  }

  return {
    verdict: comparison.verdict,
    headline: headlineFor(comparison.verdict),
    changedFields,
    unchangedFields,
    missingEvidence: comparison.verdict.kind === "inconclusive_missing_evidence"
      ? comparison.verdict.missing
      : [],
  };
}

export function formatComparisonReport(report: ComparisonReport): string {
  const lines = [report.headline];

  if (report.changedFields.length > 0) {
    lines.push(
      "Changed fields:",
      ...report.changedFields.map(
        ({ path, baseline, candidate }) =>
          `  ${path}: ${JSON.stringify(baseline)} -> ${JSON.stringify(candidate)}`,
      ),
    );
  }

  if (report.missingEvidence.length > 0) {
    lines.push(
      "Missing evidence:",
      ...report.missingEvidence.map((entry) => `  ${entry}`),
    );
  }

  return lines.join("\n");
}
