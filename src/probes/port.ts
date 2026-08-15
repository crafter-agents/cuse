import { runWithTimeout } from "../exec.ts";
import type { OS } from "../os.ts";
import {
  PROBE_SCHEMA_VERSION,
  type PortProbeResult,
  type PortProtocol,
} from "./types.ts";

const TIMEOUT_MS = 5_000;
const WINDOWS_TIMEOUT_MS = 10_000;

function source(platform: OS): string {
  return platform === "windows" ? "powershell" : "lsof";
}

function unavailable(platform: OS, warning: string): PortProbeResult {
  return {
    version: PROBE_SCHEMA_VERSION,
    noun: "port",
    platform,
    source: source(platform),
    status: "unavailable",
    found: false,
    normalized: null,
    warnings: [warning],
  };
}

export async function probePort(
  port: number,
  protocol: PortProtocol,
  platform: OS,
): Promise<PortProbeResult> {
  const envelope = {
    version: PROBE_SCHEMA_VERSION,
    noun: "port" as const,
    platform,
    source: source(platform),
  };

  if (platform !== "macos" && platform !== "linux" && platform !== "windows") {
    return unavailable(platform, `port inspection is unavailable on ${platform}`);
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    return unavailable(platform, "port must be an integer from 0 to 65535");
  }

  if (platform === "windows") {
    const command = protocol === "tcp"
      ? `Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`
      : `Get-NetUDPEndpoint -LocalPort ${port} -ErrorAction SilentlyContinue`;
    const script = `
$endpoint = ${command} | Select-Object -First 1
if ($null -eq $endpoint) { exit 0 }
[PSCustomObject]@{
  address = [string]$endpoint.LocalAddress
  port = [int]$endpoint.LocalPort
  protocol = '${protocol}'
  state = if ($null -eq $endpoint.State) { $null } else { [string]$endpoint.State }
  pid = if ($null -eq $endpoint.OwningProcess) { $null } else { [int]$endpoint.OwningProcess }
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
        || !("address" in value) || typeof value.address !== "string" || value.address === ""
        || !("port" in value) || value.port !== port
        || !("protocol" in value) || value.protocol !== protocol
        || !("state" in value) || (value.state !== null && typeof value.state !== "string")
        || !("pid" in value) || (value.pid !== null && (!Number.isSafeInteger(value.pid) || value.pid < 0))
      ) return unavailable(platform, "powershell returned an unexpected socket record");

      return {
        ...envelope,
        status: "found",
        found: true,
        normalized: {
          address: value.address,
          port: value.port,
          protocol: value.protocol,
          state: value.state,
          pid: value.pid,
        },
        warnings: [],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return unavailable(platform, message);
    }
  }

  const family = protocol === "tcp" ? "TCP" : "UDP";
  const argv = ["lsof", "-nP", `-i${family}:${port}`];
  if (protocol === "tcp") argv.push("-sTCP:LISTEN");

  try {
    const result = await runWithTimeout(argv, TIMEOUT_MS);
    if (result.timedOut) {
      return unavailable(platform, `lsof did not finish within ${TIMEOUT_MS}ms`);
    }

    const lines = result.stdout.trim().split("\n").filter(Boolean);
    if (result.code !== 0) {
      if (lines.length === 0) {
        return { ...envelope, status: "not-found", found: false, normalized: null, warnings: [] };
      }
      const details = result.stderr.trim();
      return unavailable(platform, details ? `lsof: ${details}` : `lsof exited ${result.code}`);
    }

    if (lines.length < 2) {
      return unavailable(platform, "lsof returned no socket record");
    }

    const fields = lines[1]!.trim().split(/\s+/);
    const pid = Number(fields[1]);
    const name = fields.slice(8).join(" ");
    const endpoint = name.split("->", 1)[0]!.split(" (", 1)[0]!.trim();
    const endpointMatch = endpoint.match(/^(.*):(\d+)$/);
    const stateMatch = name.match(/\(([^()]*)\)\s*$/);
    const resolvedPort = endpointMatch ? Number(endpointMatch[2]) : Number.NaN;

    if (
      !Number.isSafeInteger(pid)
      || pid < 0
      || !endpointMatch
      || endpointMatch[1] === ""
      || !Number.isSafeInteger(resolvedPort)
      || resolvedPort !== port
    ) {
      return unavailable(platform, "lsof returned an unexpected socket record");
    }

    return {
      ...envelope,
      status: "found",
      found: true,
      normalized: {
        address: endpointMatch[1]!,
        port: resolvedPort,
        protocol,
        state: stateMatch?.[1] ?? null,
        pid,
      },
      warnings: [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(platform, message);
  }
}
