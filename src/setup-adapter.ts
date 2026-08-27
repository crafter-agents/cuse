import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import type { SetupFailure } from "./compare.ts";

export type SetupCommand = {
  argv: string[];
  cwd: string;
};

export type SetupOutcome = { ok: true } | SetupFailure;

// Setup commands such as installs and builds need more time than a single cuse action.
export const DEFAULT_SETUP_TIMEOUT_MS = 120_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runSetup(
  command: SetupCommand,
  timeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
): Promise<SetupOutcome> {
  if (command.argv.length === 0) {
    return { kind: "setup_failed", message: "setup command is empty" };
  }

  const executable = command.argv[0]!;

  try {
    const proc = spawn(executable, command.argv.slice(1), {
      cwd: command.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.resume();
    const stderrText = new Response(Readable.toWeb(proc.stderr)).text();
    const exited = new Promise<number>((resolve, reject) => {
      proc.once("error", reject);
      proc.once("exit", (code) => resolve(code ?? -1));
    });
    const timedOut = Symbol("timedOut");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), timeoutMs);
    });
    const result = await Promise.race([exited, timeout]);
    if (timer !== undefined) clearTimeout(timer);

    if (result === timedOut) {
      try {
        proc.kill();
      } catch {
        // The process may have exited between the timeout and the kill.
      }
      return {
        kind: "setup_failed",
        message: `${executable} did not finish within ${timeoutMs}ms and was killed`,
      };
    }

    if (result === 0) return { ok: true };

    const stderr = await stderrText;
    const firstLine = stderr.split("\n").map((line) => line.trim()).find(Boolean);
    return {
      kind: "setup_failed",
      message: firstLine ?? `${executable} exited ${result}`,
    };
  } catch (error) {
    return {
      kind: "setup_failed",
      message: `${executable} could not be started: ${errorMessage(error)}`,
    };
  }
}
