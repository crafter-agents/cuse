import { lstat } from "node:fs/promises";
import type { Stats } from "node:fs";
import type { OS } from "../os.ts";
import { PROBE_SCHEMA_VERSION, type FileProbeResult, type FileType } from "./types.ts";

const SOURCE = "fs.lstat";

function fileType(stats: Stats): FileType {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "file";
  return "other";
}

function isoTimestamp(milliseconds: number): string | null {
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function errorDetails(error: unknown): { code?: string; message: string } {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
    return { code, message: error.message };
  }
  return { message: String(error) };
}

export async function probeFile(path: string, platform: OS): Promise<FileProbeResult> {
  const envelope = {
    version: PROBE_SCHEMA_VERSION,
    noun: "file" as const,
    platform,
    source: SOURCE,
  };

  try {
    const stats = await lstat(path);
    const type = fileType(stats);

    return {
      ...envelope,
      status: "found",
      found: true,
      normalized: {
        path,
        type,
        size: type === "file" ? stats.size : null,
        createdAt: isoTimestamp(stats.birthtimeMs),
        modifiedAt: isoTimestamp(stats.mtimeMs),
        accessedAt: isoTimestamp(stats.atimeMs),
      },
      warnings: [],
    };
  } catch (error) {
    const details = errorDetails(error);
    if (details.code === "ENOENT") {
      return {
        ...envelope,
        status: "not-found",
        found: false,
        normalized: null,
        warnings: [],
      };
    }

    return {
      ...envelope,
      status: "unavailable",
      found: false,
      normalized: null,
      warnings: [details.code ? `${details.code}: ${details.message}` : details.message],
    };
  }
}
