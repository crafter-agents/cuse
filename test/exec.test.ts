import { test, expect, describe } from "bun:test";
import { runWithTimeout, explainFailure, timeoutFor, DEFAULT_TIMEOUT_MS } from "../src/exec.ts";

describe("deadlines", () => {
  test("a command that finishes is not reported as timed out", async () => {
    const r = await runWithTimeout(["echo", "hi"], 5000);
    expect(r.code).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.stdout.trim()).toBe("hi");
  });
  test("a hung command is killed rather than waited on", async () => {
    const started = Date.now();
    const r = await runWithTimeout(["sleep", "30"], 400);
    expect(r.timedOut).toBe(true);
    // The point of the deadline: we are back in well under the sleep.
    expect(Date.now() - started).toBeLessThan(5000);
  });
  test.skipIf(process.platform !== "win32")("a Windows descendant holding output pipes cannot extend the deadline", async () => {
    const started = Date.now();
    const r = await runWithTimeout([
      "powershell", "-NoProfile", "-NonInteractive", "-Command",
      "Start-Process powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 30' -NoNewWindow; Start-Sleep 30",
    ], 300);
    expect(r.timedOut).toBe(true);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe("");
    expect(Date.now() - started).toBeLessThan(5000);
  });
  test("the timeout is explained as a hang, not as an exit code", async () => {
    const r = await runWithTimeout(["sleep", "30"], 300);
    const msg = explainFailure(["sleep"], r, 300)!;
    expect(msg).toContain("did not finish within 300ms");
    expect(msg).toContain("not responding");
  });
  test("a failing command reports what it said, not its exit code", async () => {
    const r = await runWithTimeout(["sh", "-c", "echo 'no window matching X' >&2; exit 1"], 5000);
    expect(explainFailure(["sh"], r, 5000)).toContain("no window matching X");
  });
  test("success explains nothing", async () => {
    expect(explainFailure(["echo"], await runWithTimeout(["echo", "ok"], 5000), 5000)).toBeNull();
  });
  test("slow actions get more room than the default, and an override wins", () => {
    expect(timeoutFor("launch")).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
    expect(timeoutFor("key")).toBe(DEFAULT_TIMEOUT_MS);
    expect(timeoutFor("launch", 999)).toBe(999);
    expect(timeoutFor("launch", 0)).toBe(TIMEOUT_LAUNCH);
  });
});
const TIMEOUT_LAUNCH = timeoutFor("launch");
