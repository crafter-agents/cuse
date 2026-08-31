import { test, expect, describe } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { act, exitCodeFor, fillTarget, macSessionUnreachable, pointScale, VERSION, type Result } from "../src/cli.ts";
import { buildFailureReport, formatFailureReport } from "../src/failure-report.ts";
import type { OS } from "../src/os.ts";
import { detectOS } from "../src/os.ts";
import type { Plan } from "../src/plan.ts";
import type { ScenarioRunResult } from "../src/scenario.ts";

const r = (over: Partial<Result>): Result => ({ ok: false, action: "type", os: "macos", ...over });

describe("exit codes", () => {
  test("success is 0", () => expect(exitCodeFor(r({ ok: true }))).toBe(0));
  test("bad usage is 2, so a typo is not mistaken for a machine problem", () => {
    expect(exitCodeFor(r({ error: "unknown action 'clik'" }))).toBe(2);
    expect(exitCodeFor(r({ error: "diff needs two PNG paths" }))).toBe(2);
    expect(exitCodeFor(r({ error: "invalid --button='side': expected left, right, or middle" }))).toBe(2);
    expect(exitCodeFor(r({ error: "invalid --modifiers='ctrl+bogus': unknown modifier 'bogus'" }))).toBe(2);
    expect(exitCodeFor(r({ error: "invalid scroll direction 'sideways': expected up, down, left, or right" }))).toBe(2);
  });
  test("a hang is 3, distinct from a plain failure", () => {
    expect(exitCodeFor(r({ error: "xdotool did not finish within 15000ms and was killed" }))).toBe(3);
    expect(exitCodeFor(r({ error: "settle ran out of time after 4 checks" }))).toBe(3);
    expect(exitCodeFor(r({ action: "scenario", data: { status: "timed_out" } }))).toBe(3);
  });
  test("a refusal is 4: the machine cannot do this, retrying will not help", () => {
    expect(exitCodeFor(r({ error: "`xdotool` not found: apt-get install -y xdotool" }))).toBe(4);
    expect(exitCodeFor(r({ error: "no X display: DISPLAY is unset (run under Xvfb)" }))).toBe(4);
    expect(exitCodeFor(r({ error: "the session is locked: input would go to the login window" }))).toBe(4);
    expect(exitCodeFor(r({ error: "no window server session: frame is blank" }))).toBe(4);
  });
  test("anything else is 1", () => {
    expect(exitCodeFor(r({ error: "osascript: no window matching 'Notepad'" }))).toBe(1);
  });
  test("doctor verdicts have distinct gateable exit codes", () => {
    expect(exitCodeFor(r({ action: "doctor", data: { verdict: "healthy" } }))).toBe(0);
    expect(exitCodeFor(r({ action: "doctor", data: { verdict: "degraded" } }))).toBe(1);
    expect(exitCodeFor(r({ action: "doctor", data: { verdict: "unusable" } }))).toBe(4);
  });
  test("the version is a real semver", () => expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/));
});

describe("macOS window server probe", () => {
  test("returns the existing blank-frame warning before the guarded command", async () => {
    const calls: string[] = [];
    const warning = await macSessionUnreachable(15_000, {
      tempPath: () => "/tmp/cuse-test-session.png",
      capture: async (os, out, timeoutMs) => {
        calls.push(`capture:${os}:${out}:${timeoutMs}`);
      },
      size: async () => 295,
      inspect: async (_path, bytes) => {
        calls.push(`inspect:${bytes}`);
        return "frame is blank: input actions will be delivered to no window";
      },
      remove: async () => { calls.push("remove"); },
    });

    expect(warning).toContain("frame is blank");
    expect(calls).toEqual([
      "capture:macos:/tmp/cuse-test-session.png:3000",
      "inspect:295",
      "remove",
    ]);
  });

  test("does not refuse when capture cannot determine the session state", async () => {
    let removed = false;
    const warning = await macSessionUnreachable(1500, {
      tempPath: () => "/tmp/cuse-test-session-error.png",
      capture: async () => { throw new Error("capture unavailable"); },
      size: async () => 0,
      inspect: async () => "frame is blank",
      remove: async () => { removed = true; },
    });

    expect(warning).toBeUndefined();
    expect(removed).toBe(true);
  });
});

describe("pointScale", () => {
  const runner = (stdout: string[]) => {
    let calls = 0;
    return {
      run: async () => ({
        code: 0,
        stdout: stdout[calls++] ?? "",
        stderr: "",
        timedOut: false,
      }),
      calls: () => calls,
    };
  };

  test("returns a non-1 backing scale without querying logical width", async () => {
    const stub = runner(["2\n"]);
    expect(await pointScale("macos", 3024, stub.run)).toBe(2);
    expect(stub.calls()).toBe(1);
  });

  test("overrides an ambiguous 1 when the ratio implies 2", async () => {
    const stub = runner(["1\n", "1512\n"]);
    expect(await pointScale("macos", 3024, stub.run)).toBe(2);
    expect(stub.calls()).toBe(2);
  });

  test("keeps 1 when the backing scale and ratio both imply 1", async () => {
    const stub = runner(["1\n", "1920\n"]);
    expect(await pointScale("macos", 1920, stub.run)).toBe(1);
    expect(stub.calls()).toBe(2);
  });
});

const scenarioPath = (name: string) =>
  `${Bun.env.TMPDIR ?? "/tmp"}/cuse-${name}-${process.pid}-${Date.now()}-${Math.random()}.json`;

test("scenario runs a passing file and returns structured data", async () => {
  const path = scenarioPath("passing");
  await Bun.write(path, JSON.stringify({
    version: 1,
    name: "passing CLI scenario",
    vars: {},
    defaultTimeoutMs: 1_000,
    steps: [{ type: "assert", actual: "same", operator: "eq", expected: "same" }],
  }));

  const result = await act("scenario", [path]);

  expect(result.ok).toBe(true);
  expect(exitCodeFor(result)).toBe(0);
  expect(result.data).toMatchObject({ name: "passing CLI scenario", status: "passed" });
});

test("run routes a scenario file through repeat aggregation", async () => {
  const path = scenarioPath("run-repeat");
  await Bun.write(path, JSON.stringify({
    version: 1,
    name: "repeated CLI scenario",
    vars: {},
    defaultTimeoutMs: 1_000,
    steps: [{ type: "assert", actual: "same", operator: "eq", expected: "same" }],
  }));

  const result = await act("run", [path], { repeat: 3 }, { os: "linux" });

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    name: "repeated CLI scenario",
    status: "passed",
    runs: 3,
    passed: 3,
    failed: 0,
  });
});

test("scenario dispatches cuse steps through the real CLI action", async () => {
  const path = scenarioPath("cuse-os");
  await Bun.write(path, JSON.stringify({
    version: 1,
    name: "cuse CLI scenario",
    vars: {},
    defaultTimeoutMs: 1_000,
    steps: [{ type: "cuse", action: "os", saveAs: "detected" }],
  }));

  const result = await act("scenario", [path]);

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    status: "passed",
    steps: [{ status: "passed", cuse: { ok: true } }],
  });
});

test("scenario reports a failed assertion as a plain failure", async () => {
  const path = scenarioPath("failing");
  await Bun.write(path, JSON.stringify({
    version: 1,
    name: "failing CLI scenario",
    vars: {},
    defaultTimeoutMs: 1_000,
    steps: [{ type: "assert", actual: 1, operator: "eq", expected: 2 }],
  }));

  const result = await act("scenario", [path]);

  expect(result.ok).toBe(false);
  expect(result.error).toStartWith("scenario failed: steps step 1:");
  expect(exitCodeFor(result)).toBe(1);
});

test("scenario writes its formatted failure report to the requested path", async () => {
  const path = scenarioPath("failure-report");
  const reportPath = scenarioPath("failure-report-output");
  await Bun.write(path, JSON.stringify({
    version: 1,
    name: "failure report CLI scenario",
    vars: {},
    defaultTimeoutMs: 1_000,
    steps: [{ type: "assert", actual: 1, operator: "eq", expected: 2 }],
  }));

  const result = await act("scenario", [path], { report: reportPath });
  const report = buildFailureReport(result.data as ScenarioRunResult);

  expect(result.ok).toBe(false);
  expect(report).toBeDefined();
  expect(await Bun.file(reportPath).text()).toBe(formatFailureReport(report!));
});

test("scenario does not write a failure report for a passing run", async () => {
  const path = scenarioPath("passing-report");
  const reportPath = scenarioPath("passing-report-output");
  await Bun.write(path, JSON.stringify({
    version: 1,
    name: "passing report CLI scenario",
    vars: {},
    defaultTimeoutMs: 1_000,
    steps: [{ type: "assert", actual: 1, operator: "eq", expected: 1 }],
  }));

  const result = await act("scenario", [path], { report: reportPath });

  expect(result.ok).toBe(true);
  expect(await Bun.file(reportPath).exists()).toBe(false);
});

test("scenario reports a missing file as bad usage", async () => {
  const path = scenarioPath("missing");
  const result = await act("scenario", [path]);

  expect(result).toMatchObject({ ok: false, error: `scenario file not found: ${path}` });
  expect(exitCodeFor(result)).toBe(2);
});

test("scenario rejects malformed JSON as bad usage", async () => {
  const path = scenarioPath("malformed");
  await Bun.write(path, "{not JSON");

  const result = await act("scenario", [path]);

  expect(result).toMatchObject({ ok: false, error: "scenario file must contain valid JSON" });
  expect(exitCodeFor(result)).toBe(2);
});

test("compare persists discoverable parsed JSON evidence for both sides", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cuse-cli-compare-test-"));
  const scenario = join(scratch, "scenario.json");
  const manifest = join(scratch, "comparison.json");
  const evidenceRoots: string[] = [];

  try {
    await Bun.write(scenario, JSON.stringify({
      version: 1,
      name: "JSON evidence comparison",
      vars: {},
      defaultTimeoutMs: 1_000,
      steps: [{
        type: "exec",
        argv: [process.execPath, "-e", "console.log(JSON.stringify({probe: 1}))"],
        stdout: "json",
      }],
    }));
    await Bun.write(manifest, JSON.stringify({
      scenario,
      baseline: { argv: ["true"], cwd: scratch },
      candidate: { argv: ["true"], cwd: scratch },
    }));

    const result = await act("compare", [manifest]);
    const evidence = (result.data as {
      evidence: { baseline: string; candidate: string };
    }).evidence;

    expect(result.ok).toBe(true);
    for (const evidenceDir of [evidence.baseline, evidence.candidate]) {
      evidenceRoots.push(dirname(evidenceDir));
      expect((await stat(evidenceDir)).isDirectory()).toBe(true);
      const ledger = Bun.file(join(evidenceDir, "steps.jsonl"));
      expect(await ledger.exists()).toBe(true);
      const events = (await ledger.text()).trim().split("\n").map((line) => JSON.parse(line));
      expect(events.find((event) => event.type === "terminal")).toMatchObject({
        result: { json: { ok: true, value: { probe: 1 } } },
      });
    }
  } finally {
    await Promise.all(evidenceRoots.map((root) => rm(root, { recursive: true, force: true })));
    await rm(scratch, { recursive: true, force: true });
  }
});

test("compare deletes evidence directories when --keep-evidence=false", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "cuse-cli-compare-test-"));
  const scenario = join(scratch, "scenario.json");
  const manifest = join(scratch, "comparison.json");
  const comparisonRoots = async () => new Set(
    (await readdir(tmpdir())).filter((entry) =>
      entry.startsWith("cuse-compare-baseline-") ||
      entry.startsWith("cuse-compare-candidate-")),
  );

  try {
    await Bun.write(scenario, JSON.stringify({
      version: 1,
      name: "cleaned JSON evidence comparison",
      vars: {},
      defaultTimeoutMs: 1_000,
      steps: [{
        type: "exec",
        argv: [process.execPath, "-e", "console.log(JSON.stringify({probe: 1}))"],
        stdout: "json",
      }],
    }));
    await Bun.write(manifest, JSON.stringify({
      scenario,
      baseline: { argv: ["true"], cwd: scratch },
      candidate: { argv: ["true"], cwd: scratch },
    }));
    const before = await comparisonRoots();

    const result = await act("compare", [manifest], { keepEvidence: false });

    expect(result.ok).toBe(true);
    expect((result.data as { evidence?: unknown }).evidence).toBeUndefined();
    expect(await comparisonRoots()).toEqual(before);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("click rejects an unknown button before dispatch", async () => {
  const result = await act("click", [], { button: "side" });
  expect(result).toMatchObject({ ok: false,
    error: "invalid --button='side': expected left, right, or middle" });
});

test("click rejects an unknown modifier before dispatch", async () => {
  const result = await act("click", [], { modifiers: "ctrl+bogus" });
  expect(result).toMatchObject({ ok: false,
    error: "invalid --modifiers='ctrl+bogus': unknown modifier 'bogus'" });
});

test("scroll rejects an unknown direction before dispatch", async () => {
  const result = await act("scroll", ["sideways"], { force: true });
  expect(result).toMatchObject({ ok: false,
    error: "invalid scroll direction 'sideways': expected up, down, left, or right" });
  expect(exitCodeFor(result)).toBe(2);
});

test("fill refuses to type without an aimed target", async () => {
  const result = await act("fill", ["hello"]);
  expect(result).toMatchObject({ ok: false,
    error: "fill needs --element=<name>, --role=<kind>, --window=<name>, --find=<template.png>, or coordinates" });
  expect(exitCodeFor(result)).toBe(2);
});

test("fill requires a complete coordinate pair", async () => {
  const result = await act("fill", ["hello", "40"], { element: "Name" });
  expect(result).toMatchObject({ ok: false, error: "fill coordinates need both <x> and <y>" });
  expect(exitCodeFor(result)).toBe(2);
});

test("ocr-read requires an image path", async () => {
  const result = await act("ocr-read", []);
  expect(result).toMatchObject({ ok: false, error: "ocr-read needs an image path" });
  expect(exitCodeFor(result)).toBe(2);
});

test("ocr-read recognizes text through Vision or refuses an unsupported OS", async () => {
  const result = await act("ocr-read", ["test/fixtures/ocr-sample.png"], {});
  if (result.os === "macos") {
    expect(result.ok).toBe(true);
    expect((result.data as { lines: string[] }).lines.some((line) => /Hello Vision 123/.test(line))).toBe(true);
  } else {
    expect(result).toMatchObject({
      ok: false,
      error: `ocr-read unsupported on ${result.os} - not yet built`,
    });
    expect(exitCodeFor(result)).toBe(4);
  }
}, 30_000);

test("inspect process finds a running process", async () => {
  const result = await act("inspect", ["process"], { pid: process.pid });

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ found: true, normalized: { pid: process.pid } });
}, 25_000);

test("inspect process requires a pid", async () => {
  const result = await act("inspect", ["process"]);

  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("--pid") });
});

test("inspect port reports an unused port as not found", async () => {
  const result = await act("inspect", ["port"], { port: 65_534 });

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ found: false });
}, 15_000);

test("inspect file finds a regular file", async () => {
  const result = await act("inspect", ["file", "package.json"]);

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ found: true, normalized: { type: "file" } });
});

test("inspect file reports a nonexistent path as not found", async () => {
  const result = await act("inspect", ["file", `missing-${process.pid}-${Date.now()}`]);

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ found: false });
});

test("inspect scheduled-task requires a name", async () => {
  const result = await act("inspect", ["scheduled-task"]);

  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("--name") });
});

test("inspect scheduled-task reports unavailable on a non-windows host", async () => {
  const result = await act("inspect", ["scheduled-task"], { name: `cuse-missing-${process.pid}` });

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    found: false,
    status: detectOS() === "windows" ? "not-found" : "unavailable",
  });
}, 10_000);

test("inspect service requires a name", async () => {
  const result = await act("inspect", ["service"]);

  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("--name") });
});

test("inspect service reports its host-appropriate status for a missing name", async () => {
  const result = await act("inspect", ["service"], { name: `cuse-missing-${process.pid}` });

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({
    found: false,
    status: detectOS() === "windows" ? "unavailable" : "not-found",
  });
}, 10_000);

test("inspect requires a known noun", async () => {
  expect(await act("inspect", [])).toMatchObject({ ok: false,
    error: "inspect needs a noun: process, port, file, service, or scheduled-task" });
  expect(await act("inspect", ["bogus-noun"])).toMatchObject({ ok: false,
    error: "inspect needs a noun: process, port, file, service, or scheduled-task" });
});

test("fill dispatches click, platform select-all, then type on every OS", async () => {
  for (const os of ["macos", "linux", "windows"] as OS[]) {
    const events: Array<{ kind: "plan"; value: Plan } | { kind: "run"; value: string[] }> = [];
    const run = async (argv: string[]) => { events.push({ kind: "run", value: argv }); };
    const perform = async (plan: Plan) => { events.push({ kind: "plan", value: plan }); };

    await fillTarget(os, "new value", 40, 60, run, perform);

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({ kind: "plan", value: expect.objectContaining(
      os === "macos"
        ? { kind: "native", op: "click", count: 1, x: 40, y: 60 }
        : { kind: os === "linux" ? "exec-many" : "exec" }) });
    expect(events[1]).toEqual({ kind: "run", value: expect.any(Array) });
    expect(events[2]).toEqual({ kind: "run", value: expect.any(Array) });
    expect((events[1] as { kind: "run"; value: string[] }).value.join(" ")).toContain(
      os === "macos" ? "command down" : os === "linux" ? "ctrl+a" : "^a");
    expect((events[2] as { kind: "run"; value: string[] }).value.join(" ")).toContain("new value");
  }
});
