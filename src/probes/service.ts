import { runWithTimeout } from "../exec.ts";
import type { OS } from "../os.ts";
import {
  PROBE_SCHEMA_VERSION,
  type ServiceNormalized,
  type ServiceProbeResult,
  type ServiceState,
} from "./types.ts";

const TIMEOUT_MS = 5_000;
const EXECUTABLE_WARNING = "the service executable is not available from this inspection source";
const LAUNCHCTL_WARNING = "launchctl list does not report whether a service is enabled or active";

function source(platform: OS): string {
  if (platform === "macos") return "launchctl";
  if (platform === "linux") return "systemctl";
  return "service";
}

function unavailable(platform: OS, warning: string): ServiceProbeResult {
  return {
    version: PROBE_SCHEMA_VERSION,
    noun: "service",
    platform,
    source: source(platform),
    status: "unavailable",
    found: false,
    normalized: null,
    warnings: [warning],
  };
}

export function parseLaunchctlService(output: string, name: string): ServiceNormalized {
  const record = output.trim();
  if (record === "") {
    return {
      name,
      state: "unknown",
      installed: false,
      enabled: null,
      active: null,
      running: null,
      process: null,
    };
  }

  const fields = record.split("\t");
  const pid = /^\d+$/.test(fields[0] ?? "") ? Number(fields[0]) : null;
  const validPid = pid !== null && Number.isSafeInteger(pid) && pid > 0;
  const classified = fields.length === 3 && (validPid || fields[0] === "-");

  return {
    name: fields.length === 3 && fields[2] !== "" ? fields[2]! : name,
    state: classified ? (validPid ? "running" : "stopped") : "unknown",
    installed: true,
    enabled: null,
    active: null,
    running: classified ? validPid : null,
    process: validPid ? { pid: pid!, executable: null } : null,
  };
}

function systemdState(activeState: string | undefined): ServiceState {
  if (activeState === "active") return "running";
  if (activeState === "inactive" || activeState === "failed") return "stopped";
  if (activeState === "activating") return "starting";
  if (activeState === "deactivating") return "stopping";
  return "unknown";
}

function systemdEnabled(unitFileState: string | undefined): boolean | null {
  if (unitFileState === "enabled" || unitFileState === "enabled-runtime") return true;
  if (unitFileState === "disabled") return false;
  return null;
}

export function parseSystemctlService(output: string, name: string): ServiceNormalized {
  const properties = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator >= 0) properties.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const loadState = properties.get("LoadState");
  const installed = loadState !== "not-found";
  const activeState = properties.get("ActiveState");
  const active = installed && activeState !== undefined ? activeState === "active" : null;
  const mainPid = Number(properties.get("MainPID"));
  const validPid = Number.isSafeInteger(mainPid) && mainPid > 0;

  return {
    name,
    state: installed ? systemdState(activeState) : "unknown",
    installed,
    enabled: installed ? systemdEnabled(properties.get("UnitFileState")) : null,
    active,
    running: active,
    process: installed && validPid ? { pid: mainPid, executable: null } : null,
  };
}

export async function probeService(name: string, platform: OS): Promise<ServiceProbeResult> {
  const envelope = {
    version: PROBE_SCHEMA_VERSION,
    noun: "service" as const,
    platform,
    source: source(platform),
  };

  if (platform === "windows") {
    return unavailable(platform, "service inspection is not yet implemented on Windows for this noun");
  }
  if (platform !== "macos" && platform !== "linux") {
    return unavailable(platform, `service inspection is unavailable on ${platform}`);
  }

  const argv = platform === "macos"
    ? ["launchctl", "list", name]
    : ["env", "LC_ALL=C", "systemctl", "show", name, "--no-pager", "-p", "LoadState", "-p", "ActiveState", "-p", "SubState", "-p", "UnitFileState", "-p", "MainPID", "-p", "FragmentPath"];

  try {
    const result = await runWithTimeout(argv, TIMEOUT_MS);
    if (result.timedOut) {
      return unavailable(platform, `${source(platform)} did not finish within ${TIMEOUT_MS}ms`);
    }

    if (platform === "macos") {
      if (result.code !== 0) {
        if (result.stdout.trim() === "" && result.stderr.includes("Could not find service")) {
          return { ...envelope, status: "not-found", found: false, normalized: null, warnings: [] };
        }
        const details = result.stderr.trim();
        return unavailable(platform, details ? `launchctl: ${details}` : `launchctl exited ${result.code}`);
      }
      const normalized = parseLaunchctlService(result.stdout, name);
      return {
        ...envelope,
        status: "found",
        found: true,
        normalized,
        warnings: [LAUNCHCTL_WARNING, EXECUTABLE_WARNING],
      };
    }

    if (result.code !== 0) {
      const details = result.stderr.trim();
      return unavailable(platform, details ? `systemctl: ${details}` : `systemctl exited ${result.code}`);
    }
    const normalized = parseSystemctlService(result.stdout, name);
    if (!normalized.installed) {
      return { ...envelope, status: "not-found", found: false, normalized: null, warnings: [] };
    }
    return {
      ...envelope,
      status: "found",
      found: true,
      normalized,
      warnings: [EXECUTABLE_WARNING],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(platform, message);
  }
}
