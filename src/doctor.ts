import type { OS } from "./os.ts";
import type { Probe } from "./preflight.ts";
import { requiredTool } from "./preflight.ts";
import { displaysCmd, parseDisplays } from "./display.ts";
import { isSessionLocked, LOCK_QUERY } from "./session.ts";
import { runWithTimeout, type RunResult } from "./exec.ts";
import type { MacPermission } from "./macpermissions.ts";
import { which } from "./node-compat.ts";

export type DoctorStatus = "ok" | "degraded" | "unsupported" | "error";
export type DoctorVerdict = "healthy" | "degraded" | "unusable";
export type DoctorCheck = { name: string; status: DoctorStatus; detail: string };

export type DoctorProbe = Probe & {
  read: (argv: string[], timeoutMs: number) => Promise<RunResult>;
  permission: (permission: MacPermission) => Promise<boolean | null>;
};

const CHECK_TIMEOUT_MS = 5_000;

export function summarizeDoctor(checks: DoctorCheck[]): DoctorVerdict {
  if (checks.some((check) => check.status === "error")) return "unusable";
  if (checks.some((check) => check.status === "degraded")) return "degraded";
  return "healthy";
}

function commandCheck(name: string, tool: string, probe: Probe, purpose: string): DoctorCheck {
  return probe.has(tool)
    ? { name, status: "ok", detail: `${purpose}: ${tool} is available` }
    : { name, status: "error", detail: `${purpose}: ${tool} is missing from PATH` };
}

export async function checkMacSession(probe: DoctorProbe): Promise<DoctorCheck> {
  const query = LOCK_QUERY.macos!;
  if (!probe.has(query[0]!)) return commandCheck("session", query[0]!, probe, "lock-state query");
  let locked: boolean | null;
  try {
    locked = await isSessionLocked({
      os: "macos",
      read: async () => {
        const result = await probe.read(query, CHECK_TIMEOUT_MS);
        return result.code === 0 && !result.timedOut ? result.stdout : null;
      },
    });
  } catch {
    locked = null;
  }
  if (locked === true) {
    return { name: "session", status: "error", detail: "interactive session is locked; unlock the machine before sending input" };
  }
  if (locked === false) return { name: "session", status: "ok", detail: "interactive session is unlocked" };
  return { name: "session", status: "degraded", detail: "could not determine the interactive session lock state" };
}

export async function checkMacDisplay(probe: DoctorProbe): Promise<DoctorCheck> {
  const argv = displaysCmd("macos");
  if (!probe.has(argv[0]!)) return commandCheck("display", argv[0]!, probe, "display query");
  let result: RunResult;
  try {
    result = await probe.read(argv, CHECK_TIMEOUT_MS);
  } catch {
    return { name: "display", status: "error", detail: "display query could not be started" };
  }
  if (result.timedOut) return { name: "display", status: "error", detail: "display query timed out after 5000ms" };
  if (result.code !== 0) return { name: "display", status: "error", detail: "display query failed" };
  const displays = parseDisplays(result.stdout, "macos");
  if (!displays.length) return { name: "display", status: "error", detail: "no macOS displays were reported" };
  const geometry = displays.map((display) => `${display.width}x${display.height} at ${display.x},${display.y}`).join("; ");
  return { name: "display", status: "ok", detail: `Cocoa display protocol, ${displays.length} display(s): ${geometry}` };
}

export async function checkMacCapabilities(probe: DoctorProbe): Promise<DoctorCheck[]> {
  const capabilities = [
    { name: "capture", action: "capture", tool: "screencapture", purpose: "screen capture" },
    { name: "keyboard", action: "type", tool: "osascript", purpose: "keyboard input" },
    { name: "pointer", action: "move", tool: null, purpose: "CoreGraphics pointer input" },
    { name: "windows", action: "focus", tool: "osascript", purpose: "window enumeration" },
    { name: "accessibility", action: "elements", tool: "osascript", purpose: "accessibility queries" },
  ] as const;
  const checks = capabilities.map(({ name, action, tool, purpose }) => {
    const required = requiredTool("macos", action);
    const executable = required?.tool ?? tool;
    if (!executable) return { name, status: "ok", detail: `${purpose} uses the in-process macOS backend` };
    if (probe.has(executable)) return { name, status: "ok", detail: `${purpose}: ${executable} is available` };
    const remediation = required ? `; ${required.install}` : "; restore the standard macOS system tool";
    return { name, status: "error", detail: `${purpose}: ${executable} is missing from PATH${remediation}` };
  });
  for (const [name, permission, remediation] of [
    ["capture", "screen-capture", "allow Screen & System Audio Recording in System Settings > Privacy & Security"],
    ["accessibility", "accessibility", "allow Accessibility in System Settings > Privacy & Security"],
  ] as const) {
    const checked = checks.find((check) => check.name === name)!;
    if (checked.status === "error") continue;
    const allowed = await probe.permission(permission);
    if (allowed === false) {
      checked.status = "error";
      checked.detail = `${checked.detail}; permission denied, ${remediation}`;
    } else if (allowed === null) {
      checked.status = "degraded";
      checked.detail = `${checked.detail}; permission state could not be determined`;
    } else {
      checked.detail = `${checked.detail}; permission granted`;
    }
  }
  return checks;
}

export function checkMacDependencies(probe: Probe): DoctorCheck {
  const tools = ["ioreg", "osascript", "screencapture"];
  const missing = tools.filter((tool) => !probe.has(tool));
  if (missing.length) {
    return { name: "dependencies", status: "error", detail: `required macOS system tools missing from PATH: ${missing.join(", ")}` };
  }
  return { name: "dependencies", status: "ok", detail: "all required tools ship with macOS; no external packages are required" };
}

export async function runDoctor(os: OS, probe: DoctorProbe): Promise<{ verdict: DoctorVerdict; checks: DoctorCheck[] }> {
  if (os !== "macos") {
    const checks: DoctorCheck[] = [{
      name: "platform", status: "unsupported",
      detail: `${os} doctor checks are not implemented yet; this release covers macOS only`,
    }];
    return { verdict: summarizeDoctor(checks), checks };
  }
  const checks = [
    await checkMacSession(probe),
    await checkMacDisplay(probe),
    ...await checkMacCapabilities(probe),
    checkMacDependencies(probe),
  ];
  return { verdict: summarizeDoctor(checks), checks };
}

export const realDoctorProbe: DoctorProbe = {
  env: process.env,
  has: (tool) => Boolean(which(tool)),
  read: (argv, timeoutMs) => runWithTimeout(argv, timeoutMs),
  permission: async (permission) => {
    const { readMacPermission } = await import("./macpermissions.ts");
    return readMacPermission(permission);
  },
};
