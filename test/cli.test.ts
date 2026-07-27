import { test, expect, describe } from "bun:test";
import { exitCodeFor, VERSION, type Result } from "../src/cli.ts";

const r = (over: Partial<Result>): Result => ({ ok: false, action: "type", os: "macos", ...over });

describe("exit codes", () => {
  test("success is 0", () => expect(exitCodeFor(r({ ok: true }))).toBe(0));
  test("bad usage is 2, so a typo is not mistaken for a machine problem", () => {
    expect(exitCodeFor(r({ error: "unknown action 'clik'" }))).toBe(2);
    expect(exitCodeFor(r({ error: "diff needs two PNG paths" }))).toBe(2);
  });
  test("a hang is 3, distinct from a plain failure", () => {
    expect(exitCodeFor(r({ error: "xdotool did not finish within 15000ms and was killed" }))).toBe(3);
    expect(exitCodeFor(r({ error: "settle ran out of time after 4 checks" }))).toBe(3);
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
