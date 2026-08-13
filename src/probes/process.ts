import { basename } from "node:path";
import { runWithTimeout } from "../exec.ts";
import type { OS } from "../os.ts";
import { PROBE_SCHEMA_VERSION, type ProcessProbeResult } from "./types.ts";

const SOURCE = "ps";
const TIMEOUT_MS = 5_000;

function unavailable(platform: OS, warning: string): ProcessProbeResult {
  return {
    version: PROBE_SCHEMA_VERSION,
    noun: "process",
    platform,
    source: SOURCE,
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
    source: SOURCE,
  };

  if (platform !== "macos" && platform !== "linux") {
    return unavailable(platform, `process inspection is unavailable on ${platform}`);
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
