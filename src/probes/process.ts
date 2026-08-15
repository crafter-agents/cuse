import { basename } from "node:path";
import { runWithTimeout } from "../exec.ts";
import type { OS } from "../os.ts";
import { PROBE_SCHEMA_VERSION, type ProcessProbeResult } from "./types.ts";

const TIMEOUT_MS = 5_000;
const WINDOWS_TIMEOUT_MS = 20_000;

function source(platform: OS): string {
  return platform === "windows" ? "powershell" : "ps";
}

function unavailable(platform: OS, warning: string): ProcessProbeResult {
  return {
    version: PROBE_SCHEMA_VERSION,
    noun: "process",
    platform,
    source: source(platform),
    status: "unavailable",
    found: false,
    normalized: null,
    warnings: [warning],
  };
}

export async function probeProcess(pid: number, platform: OS): Promise<ProcessProbeResult> {
  const envelope = {
    version: PROBE_SCHEMA_VERSION,
    noun: "process" as const,
    platform,
    source: source(platform),
  };

  if (platform !== "macos" && platform !== "linux" && platform !== "windows") {
    return unavailable(platform, `process inspection is unavailable on ${platform}`);
  }

  if (platform === "windows") {
    const script = `
$process = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = ${pid}" | Select-Object -First 1
if ($null -eq $process) { exit 0 }
$ownerResult = Invoke-CimMethod -InputObject $process -MethodName GetOwner -ErrorAction SilentlyContinue
$owner = if ($null -ne $ownerResult -and $ownerResult.ReturnValue -eq 0) {
  if ([string]::IsNullOrEmpty($ownerResult.Domain)) { [string]$ownerResult.User } else { "$($ownerResult.Domain)\\$($ownerResult.User)" }
} else { $null }
[PSCustomObject]@{
  pid = [int]$process.ProcessId
  name = [string]$process.Name
  executable = if ($null -eq $process.ExecutablePath) { $null } else { [string]$process.ExecutablePath }
  owner = $owner
  session = if ($null -eq $process.SessionId) { $null } else { [string]$process.SessionId }
} | ConvertTo-Json -Compress
`;

    try {
      const result = await runWithTimeout(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
        WINDOWS_TIMEOUT_MS,
      );
      if (result.timedOut) return unavailable(platform, `powershell did not finish within ${WINDOWS_TIMEOUT_MS}ms`);
      if (result.code !== 0) {
        const details = result.stderr.trim();
        return unavailable(platform, details ? `powershell: ${details}` : `powershell exited ${result.code}`);
      }
      if (result.stdout.trim() === "") {
        return { ...envelope, status: "not-found", found: false, normalized: null, warnings: [] };
      }

      const value: unknown = JSON.parse(result.stdout);
      if (
        typeof value !== "object" || value === null
        || !("pid" in value) || value.pid !== pid
        || !("name" in value) || typeof value.name !== "string" || value.name === ""
        || !("executable" in value) || (value.executable !== null && typeof value.executable !== "string")
        || !("owner" in value) || (value.owner !== null && typeof value.owner !== "string")
        || !("session" in value) || (value.session !== null && typeof value.session !== "string")
      ) return unavailable(platform, "powershell returned an unexpected process record");

      return {
        ...envelope,
        status: "found",
        found: true,
        normalized: {
          pid: value.pid,
          name: value.name,
          executable: value.executable,
          owner: value.owner,
          session: value.session,
        },
        warnings: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailable(platform, message);
    }
  }

  const argv = ["ps", "-p", String(pid), "-o", "pid=", "-o", "comm=", "-o", "user=", "-o", "sess="];

  try {
    const result = await runWithTimeout(argv, TIMEOUT_MS);
    if (result.timedOut) {
      return unavailable(platform, `ps did not finish within ${TIMEOUT_MS}ms`);
    }

    if (result.code !== 0) {
      if (result.code === 1 && result.stdout.trim() === "") {
        return {
          ...envelope,
          status: "not-found",
          found: false,
          normalized: null,
          warnings: [],
        };
      }

      const details = result.stderr.trim();
      return unavailable(platform, details ? `ps: ${details}` : `ps exited ${result.code}`);
    }

    const output = result.stdout.trim();
    if (output === "") {
      return {
        ...envelope,
        status: "not-found",
        found: false,
        normalized: null,
        warnings: [],
      };
    }

    const match = output.match(/^(\d+)\s+(.+?)\s+(\S+)\s+(\S+)$/);
    if (!match) return unavailable(platform, "ps returned an unexpected process record");

    const resolvedPid = Number(match[1]);
    const executable = match[2]!.trim();
    if (!Number.isSafeInteger(resolvedPid) || resolvedPid !== pid || executable === "") {
      return unavailable(platform, "ps returned an invalid process identity");
    }

    return {
      ...envelope,
      status: "found",
      found: true,
      normalized: {
        pid: resolvedPid,
        name: basename(executable),
        executable,
        owner: match[3]!,
        session: match[4]!,
      },
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(platform, message);
  }
}
