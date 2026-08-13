import { runWithTimeout } from "../exec.ts";
import type { OS } from "../os.ts";
import {
  PROBE_SCHEMA_VERSION,
  type PortProbeResult,
  type PortProtocol,
} from "./types.ts";

const SOURCE = "lsof";
const TIMEOUT_MS = 5_000;

function unavailable(platform: OS, warning: string): PortProbeResult {
  return {
    version: PROBE_SCHEMA_VERSION,
    noun: "port",
    platform,
    source: SOURCE,
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
    source: SOURCE,
  };

  if (platform !== "macos" && platform !== "linux") {
    return unavailable(platform, `port inspection is unavailable on ${platform}`);
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    return unavailable(platform, "port must be an integer from 0 to 65535");
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
