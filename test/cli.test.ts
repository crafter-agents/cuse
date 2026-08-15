import { test, expect, describe } from "bun:test";
import { act, exitCodeFor, fillTarget, VERSION, type Result } from "../src/cli.ts";
import type { OS } from "../src/os.ts";
import { detectOS } from "../src/os.ts";
import type { Plan } from "../src/plan.ts";

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
  });
  test("anything else is 1", () => {
    expect(exitCodeFor(r({ error: "osascript: no window matching 'Notepad'" }))).toBe(1);
  });
  test("the version is a real semver", () => expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/));
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
}, 15_000);

test("inspect process requires a pid", async () => {
  const result = await act("inspect", ["process"]);

  expect(result).toMatchObject({ ok: false, error: expect.stringContaining("--pid") });
});

test("inspect port reports an unused port as not found", async () => {
  const result = await act("inspect", ["port"], { port: 65_534 });

  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ found: false });
}, 10_000);

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
});

test("inspect requires a known noun", async () => {
  expect(await act("inspect", [])).toMatchObject({ ok: false,
    error: "inspect needs a noun: process, port, file, or scheduled-task" });
  expect(await act("inspect", ["service"])).toMatchObject({ ok: false,
    error: "inspect needs a noun: process, port, file, or scheduled-task" });
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
