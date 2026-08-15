import { describe, expect, test } from "bun:test";
import {
  parseScheduledTaskJson,
  probeScheduledTask,
} from "../../src/probes/scheduled-task.ts";
import { parseProbeResult } from "../../src/probes/types.ts";

describe("scheduled-task probe", () => {
  test("parses PowerShell's shaped task JSON", () => {
    const json = JSON.stringify({
      name: "Nightly backup",
      state: "Ready",
      principal: "SYSTEM",
      runLevel: "Highest",
      triggers: [
        {
          type: "MSFT_TaskDailyTrigger",
          enabled: true,
          startBoundary: "2026-08-13T02:00:00",
        },
      ],
      actions: [
        {
          type: "MSFT_TaskExecAction",
          execute: "C:\\Tools\\backup.exe",
          arguments: "--quiet",
          workingDirectory: "C:\\Tools",
        },
      ],
      executionTimeLimit: "PT0S",
    });

    expect(parseScheduledTaskJson(json)).toEqual({
      name: "Nightly backup",
      state: "ready",
      principal: "SYSTEM",
      runLevel: "Highest",
      triggers: [
        {
          type: "MSFT_TaskDailyTrigger",
          enabled: true,
          startBoundary: "2026-08-13T02:00:00",
        },
      ],
      actions: [
        {
          type: "MSFT_TaskExecAction",
          execute: "C:\\Tools\\backup.exe",
          arguments: "--quiet",
          workingDirectory: "C:\\Tools",
        },
      ],
      executionTimeLimit: "PT0S",
    });
  });

  test("rejects empty and malformed output", () => {
    expect(parseScheduledTaskJson("")).toBeNull();
    expect(parseScheduledTaskJson("{not json}")).toBeNull();
    expect(parseScheduledTaskJson('{"name":"incomplete"}')).toBeNull();
  });

  test("reports unsupported hosts as unavailable", async () => {
    const result = await probeScheduledTask("anything", "unknown");

    expect(result.status).toBe("unavailable");
    expect(result.found).toBe(false);
    expect(result.normalized).toBeNull();
    expect(result.platform).toBe("windows");
    expect(parseProbeResult(result).ok).toBe(true);
  });
});
