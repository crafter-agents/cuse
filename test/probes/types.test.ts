import { describe, expect, test } from "bun:test";
import { parseProbeResult, PROBE_SCHEMA_VERSION, type ProbeNoun } from "../../src/probes/types.ts";

const envelope = (noun: ProbeNoun, normalized: Record<string, unknown>) => ({
  version: PROBE_SCHEMA_VERSION,
  noun,
  platform: noun === "scheduled-task" ? "windows" : "linux",
  status: "found",
  found: true,
  source: "structured fixture",
  normalized,
  warnings: [],
});

const valid = {
  process: { pid: 42, name: "worker", executable: "/usr/bin/worker", owner: "agent", session: "2" },
  port: { address: "127.0.0.1", port: 8080, protocol: "tcp", state: "listen", pid: 42 },
  file: { path: "/tmp/result.json", type: "file", size: 128, createdAt: null, modifiedAt: "2026-08-12T12:00:00Z", accessedAt: null, hash: { algorithm: "sha256", value: "abc" } },
  service: { name: "worker", state: "running", installed: true, enabled: true, active: true, running: true, process: { pid: 42, executable: "/usr/bin/worker" } },
  "scheduled-task": {
    name: "Proxy",
    state: "ready",
    principal: "SYSTEM",
    runLevel: "highest",
    triggers: [{ type: "logon", enabled: true, startBoundary: null }],
    actions: [{ type: "exec", execute: "proxy.exe", arguments: "serve", workingDirectory: null }],
    executionTimeLimit: "PT0S",
  },
  "systemd-unit": { name: "ssh.service", loadState: "loaded", activeState: "active", subState: "running", unitFileState: "enabled", mainPid: 101, fragmentPath: "/usr/lib/systemd/system/ssh.service" },
} satisfies Record<ProbeNoun, Record<string, unknown>>;

describe("probe result schema", () => {
  for (const noun of Object.keys(valid) as ProbeNoun[]) {
    test(`parses a valid ${noun} result`, () => {
      const result = parseProbeResult(envelope(noun, valid[noun]));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.result.noun).toBe(noun);
        expect(result.result.normalized).toEqual(valid[noun]);
      }
    });
  }

  const malformed: Record<ProbeNoun, { field: string; value: unknown }> = {
    process: { field: "pid", value: "42" },
    port: { field: "port", value: 70_000 },
    file: { field: "type", value: "socket" },
    service: { field: "installed", value: "yes" },
    "scheduled-task": { field: "executionTimeLimit", value: 0 },
    "systemd-unit": { field: "mainPid", value: -1 },
  };

  for (const noun of Object.keys(malformed) as ProbeNoun[]) {
    test(`rejects a malformed ${noun} result`, () => {
      const mutation = malformed[noun];
      const result = parseProbeResult(envelope(noun, { ...valid[noun], [mutation.field]: mutation.value }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("invalid_probe");
        expect(result.error.path).toBe(`$.normalized.${mutation.field}`);
        expect(result.error.message).toContain(mutation.field);
      }
    });
  }

  test("preserves scheduled-task ISO duration strings", () => {
    const result = parseProbeResult(envelope("scheduled-task", valid["scheduled-task"]));
    expect(result.ok).toBe(true);
    if (result.ok && result.result.noun === "scheduled-task") {
      expect(result.result.normalized.executionTimeLimit).toBe("PT0S");
    }
  });

  test("rejects a result without found", () => {
    const { found: _found, ...missingFound } = envelope("process", valid.process);
    const result = parseProbeResult(missingFound);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.found");
  });

  test("rejects an unknown normalized service state", () => {
    const result = parseProbeResult(envelope("service", { ...valid.service, state: "sleeping" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.normalized.state");
  });

  test("represents source unavailability separately from not found", () => {
    const unavailable = {
      ...envelope("process", valid.process),
      status: "unavailable",
      found: false,
      normalized: null,
      warnings: ["process source is unavailable"],
    };
    const result = parseProbeResult(unavailable);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.status).toBe("unavailable");
      expect(result.result.found).toBe(false);
      expect(result.result.normalized).toBeNull();
    }
    expect(unavailable.status).not.toBe("not-found");
  });

  test("rejects source unavailability with normalized probe data", () => {
    const result = parseProbeResult({
      ...envelope("process", valid.process),
      status: "unavailable",
      found: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.normalized");
  });
});
