import { describe, expect, test } from "bun:test";
import { detectOS } from "../../src/os.ts";
import {
  parseLaunchctlService,
  parseSystemctlService,
  probeService,
} from "../../src/probes/service.ts";
import { parseProbeResult } from "../../src/probes/types.ts";

describe("service probe", () => {
  test("parses launchctl service records", () => {
    expect(parseLaunchctlService("321\t0\tcom.example.running\n", "com.example.running")).toEqual({
      name: "com.example.running",
      state: "running",
      installed: true,
      enabled: null,
      active: null,
      running: true,
      process: { pid: 321, executable: null },
    });
    expect(parseLaunchctlService("-\t0\tcom.example.stopped\n", "com.example.stopped")).toEqual({
      name: "com.example.stopped",
      state: "stopped",
      installed: true,
      enabled: null,
      active: null,
      running: false,
      process: null,
    });
    expect(parseLaunchctlService("", "com.example.missing")).toEqual({
      name: "com.example.missing",
      state: "unknown",
      installed: false,
      enabled: null,
      active: null,
      running: null,
      process: null,
    });
  });

  test("parses systemctl service properties", () => {
    expect(parseSystemctlService([
      "LoadState=loaded", "ActiveState=active", "SubState=running",
      "UnitFileState=enabled", "MainPID=456", "FragmentPath=/etc/systemd/system/example.service",
    ].join("\n"), "example.service")).toEqual({
      name: "example.service",
      state: "running",
      installed: true,
      enabled: true,
      active: true,
      running: true,
      process: { pid: 456, executable: null },
    });
    expect(parseSystemctlService([
      "LoadState=loaded", "ActiveState=inactive", "SubState=dead",
      "UnitFileState=disabled", "MainPID=0", "FragmentPath=/usr/lib/systemd/system/example.service",
    ].join("\n"), "example.service")).toEqual({
      name: "example.service",
      state: "stopped",
      installed: true,
      enabled: false,
      active: false,
      running: false,
      process: null,
    });
    expect(parseSystemctlService("LoadState=not-found\nActiveState=inactive\nMainPID=0\n", "missing.service")).toEqual({
      name: "missing.service",
      state: "unknown",
      installed: false,
      enabled: null,
      active: null,
      running: null,
      process: null,
    });
  });

  test("reports an obviously missing service on the current platform", async () => {
    const result = await probeService(
      "com.crafter-agents.cuse.definitely-not-a-real-service",
      detectOS(),
    );

    expect(result.status).toBe("not-found");
    expect(result.found).toBe(false);
    expect(parseProbeResult(result).ok).toBe(true);
  }, 10_000);

  for (const platform of ["unknown", "windows"] as const) {
    test(`reports ${platform} as unavailable`, async () => {
      const result = await probeService("anything", platform);

      expect(result.status).toBe("unavailable");
      expect(result.found).toBe(false);
      expect(result.normalized).toBeNull();
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(parseProbeResult(result).ok).toBe(true);
    });
  }
});
