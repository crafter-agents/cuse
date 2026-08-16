import { describe, expect, test } from "bun:test";
import {
  buildComparisonReport,
  formatComparisonReport,
} from "../src/compare-report.ts";
import type { ScenarioComparison } from "../src/compare.ts";

describe("comparison report", () => {
  test("reports a reproduced failure fixed by the candidate", () => {
    const comparison: ScenarioComparison = {
      verdict: { kind: "reproduced_and_fixed" },
      fields: [{
        path: "status",
        baseline: "failed",
        candidate: "passed",
        equal: false,
      }],
    };

    const report = buildComparisonReport(comparison);

    expect(report.changedFields).toHaveLength(1);
    expect(report.unchangedFields).toHaveLength(0);
    expect(report.headline).toContain("fixed");
  });

  test("reports a reproduced failure that still fails", () => {
    const report = buildComparisonReport({
      verdict: { kind: "reproduced_and_still_failing" },
      fields: [],
    });

    expect(report.headline).toContain("still fails");
  });

  test("reports when the baseline unexpectedly passes", () => {
    const report = buildComparisonReport({
      verdict: { kind: "baseline_unexpectedly_passes", observedStatus: "passed" },
      fields: [],
    });

    expect(report.headline).toContain("observed status: passed");
  });

  test("reports which side failed setup", () => {
    const report = buildComparisonReport({
      verdict: { kind: "baseline_or_candidate_setup_failed", sides: ["candidate"] },
      fields: [],
    });

    expect(report.headline).toContain("candidate");
  });

  test("surfaces missing evidence in structured and formatted reports", () => {
    const report = buildComparisonReport({
      verdict: {
        kind: "inconclusive_missing_evidence",
        missing: ["baseline.steps[0].message"],
      },
      fields: [],
    });

    expect(report.missingEvidence).toEqual(["baseline.steps[0].message"]);
    expect(formatComparisonReport(report)).toContain("baseline.steps[0].message");
  });

  test("renders a changed probe value on one line", () => {
    const comparison: ScenarioComparison = {
      verdict: { kind: "reproduced_and_fixed" },
      fields: [{
        path: "steps[0].cuse.data.retention",
        baseline: "PT72H",
        candidate: "PT0S",
        equal: false,
      }],
    };

    const output = formatComparisonReport(buildComparisonReport(comparison));
    const fieldLine = output.split("\n").find((line) =>
      line.includes("steps[0].cuse.data.retention")
    );

    expect(fieldLine).toContain("PT72H");
    expect(fieldLine).toContain("PT0S");
  });

  test("omits unchanged fields from formatted text", () => {
    const report = buildComparisonReport({
      verdict: { kind: "reproduced_and_fixed" },
      fields: [
        { path: "status", baseline: "failed", candidate: "passed", equal: false },
        {
          path: "steps[0].message",
          baseline: "same",
          candidate: "same",
          equal: true,
        },
      ],
    });

    const output = formatComparisonReport(report);

    expect(output).toContain("status");
    expect(output).not.toContain("steps[0].message");
  });

  test("omits empty sections", () => {
    const output = formatComparisonReport(buildComparisonReport({
      verdict: { kind: "reproduced_and_still_failing" },
      fields: [],
    }));

    expect(output).not.toContain("Changed fields:");
    expect(output).not.toContain("Missing evidence:");
  });

  test("builds and formats deterministic reports", () => {
    const comparison: ScenarioComparison = {
      verdict: { kind: "reproduced_and_fixed" },
      fields: [{
        path: "status",
        baseline: "failed",
        candidate: "passed",
        equal: false,
      }],
    };

    const firstReport = buildComparisonReport(comparison);
    const secondReport = buildComparisonReport(comparison);

    expect(firstReport).toEqual(secondReport);
    expect(formatComparisonReport(firstReport)).toBe(formatComparisonReport(firstReport));
  });
});
