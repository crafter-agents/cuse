import { runWithTimeout } from "../exec.ts";
import type { OS } from "../os.ts";
import {
  PROBE_SCHEMA_VERSION,
  type ScheduledTaskNormalized,
  type ScheduledTaskProbeResult,
  type ScheduledTaskState,
} from "./types.ts";

// PowerShell shapes cmdlet objects into this small, stable JSON record before
// serialization. In particular, CIM metadata never crosses into this parser.
const SOURCE = "powershell";
const TIMEOUT_MS = 5_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function normalizeState(value: string): ScheduledTaskState {
  const state = value.toLowerCase();
  if (state === "disabled" || state === "queued" || state === "ready" || state === "running") {
    return state;
  }
  return "unknown";
}

export function parseScheduledTaskJson(json: string): ScheduledTaskNormalized | null {
  if (json.trim() === "") return null;

  try {
    const value: unknown = JSON.parse(json);
    if (!record(value) || typeof value.name !== "string" || typeof value.state !== "string") {
      return null;
    }
    if (
      !nullableString(value.principal)
      || !nullableString(value.runLevel)
      || !nullableString(value.executionTimeLimit)
      || !Array.isArray(value.triggers)
      || !Array.isArray(value.actions)
    ) {
      return null;
    }

    const triggers = value.triggers.map((trigger) => {
      if (
        !record(trigger)
        || typeof trigger.type !== "string"
        || (trigger.enabled !== null && typeof trigger.enabled !== "boolean")
        || !nullableString(trigger.startBoundary)
      ) {
        throw new TypeError("invalid trigger");
      }
      return {
        type: trigger.type,
        enabled: trigger.enabled,
        startBoundary: trigger.startBoundary,
      };
    });
    const actions = value.actions.map((action) => {
      if (
        !record(action)
        || typeof action.type !== "string"
        || !nullableString(action.execute)
        || !nullableString(action.arguments)
        || !nullableString(action.workingDirectory)
      ) {
        throw new TypeError("invalid action");
      }
      return {
        type: action.type,
        execute: action.execute,
        arguments: action.arguments,
        workingDirectory: action.workingDirectory,
      };
    });

    return {
      name: value.name,
      state: normalizeState(value.state),
      principal: value.principal,
      runLevel: value.runLevel,
      triggers,
      actions,
      executionTimeLimit: value.executionTimeLimit,
    };
  } catch {
    return null;
  }
}

function unavailable(warning: string): ScheduledTaskProbeResult {
  return {
    version: PROBE_SCHEMA_VERSION,
    noun: "scheduled-task",
    platform: "windows",
    source: SOURCE,
    status: "unavailable",
    found: false,
    normalized: null,
    warnings: [warning],
  };
}

export async function probeScheduledTask(name: string, host: OS): Promise<ScheduledTaskProbeResult> {
  const envelope = {
    version: PROBE_SCHEMA_VERSION,
    noun: "scheduled-task" as const,
    platform: "windows" as const,
    source: SOURCE,
  };

  if (host !== "windows") {
    return unavailable(`scheduled-task inspection is unavailable on ${host}`);
  }

  const encodedName = Buffer.from(name, "utf8").toString("base64");
  const script = `
$name = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedName}'))
$task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $task) { exit 0 }
$info = Get-ScheduledTaskInfo -InputObject $task -ErrorAction Stop
$state = if ($null -ne $info.State) { [string]$info.State } else { [string]$task.State }
[PSCustomObject]@{
  name = [string]$task.TaskName
  state = $state
  principal = if ($null -eq $task.Principal.UserId) { $null } else { [string]$task.Principal.UserId }
  runLevel = if ($null -eq $task.Principal.RunLevel) { $null } else { [string]$task.Principal.RunLevel }
  triggers = @($task.Triggers | ForEach-Object { [PSCustomObject]@{
    type = [string]$_.CimClass.CimClassName
    enabled = if ($null -eq $_.Enabled) { $null } else { [bool]$_.Enabled }
    startBoundary = if ($null -eq $_.StartBoundary) { $null } else { [string]$_.StartBoundary }
  } })
  actions = @($task.Actions | ForEach-Object { [PSCustomObject]@{
    type = [string]$_.CimClass.CimClassName
    execute = if ($null -eq $_.Execute) { $null } else { [string]$_.Execute }
    arguments = if ($null -eq $_.Arguments) { $null } else { [string]$_.Arguments }
    workingDirectory = if ($null -eq $_.WorkingDirectory) { $null } else { [string]$_.WorkingDirectory }
  } })
  executionTimeLimit = if ($null -eq $task.Settings.ExecutionTimeLimit) { $null } else { [string]$task.Settings.ExecutionTimeLimit }
} | ConvertTo-Json -Depth 4 -Compress
`;

  try {
    const result = await runWithTimeout(
      ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
      TIMEOUT_MS,
    );
    if (result.timedOut) {
      return unavailable(`powershell did not finish within ${TIMEOUT_MS}ms`);
    }
    if (result.code !== 0) {
      const details = result.stderr.trim();
      return unavailable(details ? `powershell: ${details}` : `powershell exited ${result.code}`);
    }
    if (result.stdout.trim() === "") {
      return { ...envelope, status: "not-found", found: false, normalized: null, warnings: [] };
    }

    const normalized = parseScheduledTaskJson(result.stdout);
    if (normalized === null) return unavailable("powershell returned an unexpected task record");
    return { ...envelope, status: "found", found: true, normalized, warnings: [] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(message);
  }
}
