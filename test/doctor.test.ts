import { describe, expect, test } from "bun:test";
import {
  checkMacCapabilities,
  checkMacDependencies,
  checkMacDisplay,
  checkMacSession,
  runDoctor,
  summarizeDoctor,
  type DoctorCheck,
  type DoctorProbe,
} from "../src/doctor.ts";
import type { RunResult } from "../src/exec.ts";

const result = (stdout = "", over: Partial<RunResult> = {}): RunResult => ({
  code: 0, stdout, stderr: "", timedOut: false, ...over,
});

function probe(outputs: RunResult[] = [], missing: string[] = []): DoctorProbe {
  let read = 0;
  return {
    env: {},
    has: (tool) => !missing.includes(tool),
    read: async () => outputs[read++] ?? result(),
    permission: async () => true,
  };
}

const check = (status: DoctorCheck["status"]): DoctorCheck => ({ name: status, status, detail: status });

describe("doctor summary", () => {
  test("healthy when every applicable check is ok", () => {
    expect(summarizeDoctor([check("ok")])).toBe("healthy");
  });
  test("degraded when a check is uncertain", () => {
    expect(summarizeDoctor([check("ok"), check("degraded")])).toBe("degraded");
  });
  test("unusable when any check errors", () => {
    expect(summarizeDoctor([check("degraded"), check("error")])).toBe("unusable");
  });
  test("unsupported checks do not affect the verdict", () => {
    expect(summarizeDoctor([check("ok"), check("unsupported")])).toBe("healthy");
  });
});

describe("macOS checks", () => {
  test("reads an unlocked session through the injected lock probe", async () => {
    const raw = "<key>CGSSessionScreenIsLocked</key><false/>";
    expect(await checkMacSession(probe([result(raw)]))).toMatchObject({ name: "session", status: "ok" });
  });
  test("a locked session is unusable and gives remediation", async () => {
    const raw = "<key>CGSSessionScreenIsLocked</key><true/>";
    const checked = await checkMacSession(probe([result(raw)]));
    expect(checked.status).toBe("error");
    expect(checked.detail).toContain("unlock");
  });
  test("parses display geometry from an injected command result", async () => {
    const checked = await checkMacDisplay(probe([result("0\t0\t1512\t982\n1512\t0\t1920\t1080")]));
    expect(checked.status).toBe("ok");
    expect(checked.detail).toContain("2 display(s)");
    expect(checked.detail).toContain("1920x1080");
  });
  test("a bounded display timeout is an error", async () => {
    const checked = await checkMacDisplay(probe([result("", { code: -1, timedOut: true })]));
    expect(checked).toMatchObject({ name: "display", status: "error" });
    expect(checked.detail).toContain("5000ms");
  });
  test("capability tools and native pointer support are reported separately", async () => {
    const checks = await checkMacCapabilities(probe([], ["screencapture"]));
    expect(checks.find((item) => item.name === "capture")?.status).toBe("error");
    expect(checks.find((item) => item.name === "pointer")?.status).toBe("ok");
  });
  test("denied capture permission is unusable and actionable", async () => {
    const fake = probe();
    fake.permission = async (permission) => permission !== "screen-capture";
    const checked = (await checkMacCapabilities(fake)).find((item) => item.name === "capture")!;
    expect(checked.status).toBe("error");
    expect(checked.detail).toContain("System Settings");
  });
  test("dependencies identify a missing macOS system tool", () => {
    const checked = checkMacDependencies(probe([], ["ioreg"]));
    expect(checked.status).toBe("error");
    expect(checked.detail).toContain("ioreg");
  });
  test("the composed macOS report is healthy with hermetic successful probes", async () => {
    const report = await runDoctor("macos", probe([
      result("<key>CGSSessionScreenIsLocked</key><false/>"),
      result("0\t0\t1512\t982"),
    ]));
    expect(report.verdict).toBe("healthy");
    expect(report.checks.map((item) => item.name)).toEqual([
      "session", "display", "capture", "keyboard", "pointer", "windows", "accessibility", "dependencies",
    ]);
  });
  test("non-macOS is explicit unsupported, not broken", async () => {
    const report = await runDoctor("linux", probe());
    expect(report.verdict).toBe("healthy");
    expect(report.checks).toEqual([expect.objectContaining({ status: "unsupported" })]);
  });
});
