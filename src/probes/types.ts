import type { OS } from "../os.ts";

export const PROBE_SCHEMA_VERSION = 1 as const;

export type ProbeNoun =
  | "process"
  | "port"
  | "file"
  | "service"
  | "scheduled-task"
  | "systemd-unit";

export type ProbeSource =
  | { status: "found"; found: true }
  | { status: "not-found"; found: false }
  | { status: "unavailable"; found: false };

export type ProcessNormalized = {
  pid: number;
  name: string;
  executable: string | null;
  owner: string | null;
  session: string | null;
};

export type PortProtocol = "tcp" | "udp";
export type PortNormalized = {
  address: string;
  port: number;
  protocol: PortProtocol;
  state: string | null;
  pid: number | null;
};

export type FileType = "file" | "directory" | "symlink" | "other";
export type FileHash = { algorithm: string; value: string };
export type FileNormalized = {
  path: string;
  type: FileType;
  size: number | null;
  createdAt: string | null;
  modifiedAt: string | null;
  accessedAt: string | null;
  hash?: FileHash;
};

export type ServiceProcess = {
  pid: number;
  executable: string | null;
};
export type ServiceState = "running" | "stopped" | "paused" | "starting" | "stopping" | "unknown";
export type ServiceNormalized = {
  name: string;
  state: ServiceState;
  installed: boolean;
  enabled: boolean | null;
  active: boolean | null;
  running: boolean | null;
  process: ServiceProcess | null;
};

export type ScheduledTaskState = "disabled" | "queued" | "ready" | "running" | "unknown";
export type ScheduledTaskTrigger = {
  type: string;
  enabled: boolean | null;
  startBoundary: string | null;
};
export type ScheduledTaskAction = {
  type: string;
  execute: string | null;
  arguments: string | null;
  workingDirectory: string | null;
};
export type ScheduledTaskNormalized = {
  name: string;
  state: ScheduledTaskState;
  principal: string | null;
  runLevel: string | null;
  triggers: ScheduledTaskTrigger[];
  actions: ScheduledTaskAction[];
  executionTimeLimit: string | null;
};

export type SystemdUnitNormalized = {
  name: string;
  loadState: string;
  activeState: string;
  subState: string;
  unitFileState: string | null;
  mainPid: number | null;
  fragmentPath: string | null;
};

type ProbeEnvelopeBase<N extends ProbeNoun, P extends OS> = {
  version: typeof PROBE_SCHEMA_VERSION;
  noun: N;
  platform: P;
  source: string;
  raw?: Record<string, unknown>;
  warnings: string[];
};

export type ProbeEnvelope<N extends ProbeNoun, T, P extends OS = OS> = ProbeEnvelopeBase<N, P> & (
  | ({ normalized: T } & Extract<ProbeSource, { status: "found" }>)
  | ({ normalized: null } & Exclude<ProbeSource, { status: "found" }>)
);

export type ProcessProbeResult = ProbeEnvelope<"process", ProcessNormalized>;
export type PortProbeResult = ProbeEnvelope<"port", PortNormalized>;
export type FileProbeResult = ProbeEnvelope<"file", FileNormalized>;
export type ServiceProbeResult = ProbeEnvelope<"service", ServiceNormalized>;
export type ScheduledTaskProbeResult = ProbeEnvelope<"scheduled-task", ScheduledTaskNormalized, "windows">;
export type SystemdUnitProbeResult = ProbeEnvelope<"systemd-unit", SystemdUnitNormalized, "linux">;

export type ProbeResult =
  | ProcessProbeResult
  | PortProbeResult
  | FileProbeResult
  | ServiceProbeResult
  | ScheduledTaskProbeResult
  | SystemdUnitProbeResult;

export type ProbeValidationError = {
  code: "invalid_probe";
  path: string;
  message: string;
};

export type ProbeParseResult =
  | { ok: true; result: ProbeResult }
  | { ok: false; error: ProbeValidationError };

const NOUNS = new Set<ProbeNoun>(["process", "port", "file", "service", "scheduled-task", "systemd-unit"]);
const PLATFORMS = new Set<OS>(["macos", "linux", "windows", "unknown"]);
const PORT_PROTOCOLS = new Set<PortProtocol>(["tcp", "udp"]);
const FILE_TYPES = new Set<FileType>(["file", "directory", "symlink", "other"]);
const TASK_STATES = new Set<ScheduledTaskState>(["disabled", "queued", "ready", "running", "unknown"]);
const SERVICE_STATES = new Set<ServiceState>(["running", "stopped", "paused", "starting", "stopping", "unknown"]);
const SOURCE_STATUSES = new Set<ProbeSource["status"]>(["found", "not-found", "unavailable"]);
const ENVELOPE_KEYS = new Set(["version", "noun", "platform", "status", "found", "source", "normalized", "raw", "warnings"]);

function fail(path: string, message: string): ProbeParseResult {
  return { ok: false, error: { code: "invalid_probe", path, message } };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, allowed: Set<string>): string | undefined {
  return Object.keys(value).find((key) => !allowed.has(key));
}

function requireKeys(value: Record<string, unknown>, keys: string[], path: string): ProbeParseResult | undefined {
  const missing = keys.find((key) => !(key in value));
  return missing ? fail(`${path}.${missing}`, `${missing} is required`) : undefined;
}

function validateShape(value: unknown, path: string, keys: string[]): ProbeParseResult | Record<string, unknown> {
  if (!record(value)) return fail(path, "normalized must be an object");
  const extra = unknownKey(value, new Set(keys));
  if (extra) return fail(`${path}.${extra}`, `unknown key: ${extra}`);
  return requireKeys(value, keys.filter((key) => key !== "hash"), path) ?? value;
}

function isFailure(value: ProbeParseResult | Record<string, unknown>): value is ProbeParseResult {
  return "ok" in value;
}

function string(value: unknown): boolean {
  return typeof value === "string";
}

function nullableString(value: unknown): boolean {
  return value === null || string(value);
}

function integer(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function nullableInteger(value: unknown): boolean {
  return value === null || integer(value);
}

function nullableBoolean(value: unknown): boolean {
  return value === null || typeof value === "boolean";
}

function invalidField(path: string, field: string, expectation: string): ProbeParseResult {
  return fail(`${path}.${field}`, `${field} must be ${expectation}`);
}

function validateProcess(value: unknown, path: string): ProbeParseResult | undefined {
  const shape = validateShape(value, path, ["pid", "name", "executable", "owner", "session"]);
  if (isFailure(shape)) return shape;
  if (!integer(shape.pid)) return invalidField(path, "pid", "a non-negative integer");
  if (!string(shape.name)) return invalidField(path, "name", "a string");
  for (const field of ["executable", "owner", "session"] as const) {
    if (!nullableString(shape[field])) return invalidField(path, field, "a string or null");
  }
}

function validatePort(value: unknown, path: string): ProbeParseResult | undefined {
  const shape = validateShape(value, path, ["address", "port", "protocol", "state", "pid"]);
  if (isFailure(shape)) return shape;
  if (!string(shape.address)) return invalidField(path, "address", "a string");
  if (!integer(shape.port) || (shape.port as number) > 65_535) return invalidField(path, "port", "an integer from 0 to 65535");
  if (!PORT_PROTOCOLS.has(shape.protocol as PortProtocol)) return invalidField(path, "protocol", "tcp or udp");
  if (!nullableString(shape.state)) return invalidField(path, "state", "a string or null");
  if (!nullableInteger(shape.pid)) return invalidField(path, "pid", "a non-negative integer or null");
}

function validateFile(value: unknown, path: string): ProbeParseResult | undefined {
  const shape = validateShape(value, path, ["path", "type", "size", "createdAt", "modifiedAt", "accessedAt", "hash"]);
  if (isFailure(shape)) return shape;
  if (!string(shape.path)) return invalidField(path, "path", "a string");
  if (!FILE_TYPES.has(shape.type as FileType)) return invalidField(path, "type", "file, directory, symlink or other");
  if (!nullableInteger(shape.size)) return invalidField(path, "size", "a non-negative integer or null");
  for (const field of ["createdAt", "modifiedAt", "accessedAt"] as const) {
    if (!nullableString(shape[field])) return invalidField(path, field, "a string or null");
  }
  if (shape.hash !== undefined) {
    if (!record(shape.hash) || Object.keys(shape.hash).some((key) => key !== "algorithm" && key !== "value")) return invalidField(path, "hash", "an algorithm and value object");
    if (!string(shape.hash.algorithm) || !string(shape.hash.value)) return invalidField(path, "hash", "an algorithm and value object");
  }
}

function validateService(value: unknown, path: string): ProbeParseResult | undefined {
  const shape = validateShape(value, path, ["name", "state", "installed", "enabled", "active", "running", "process"]);
  if (isFailure(shape)) return shape;
  if (!string(shape.name)) return invalidField(path, "name", "a string");
  if (!SERVICE_STATES.has(shape.state as ServiceState)) return invalidField(path, "state", "a normalized service state");
  if (typeof shape.installed !== "boolean") return invalidField(path, "installed", "a boolean");
  for (const field of ["enabled", "active", "running"] as const) {
    if (!nullableBoolean(shape[field])) return invalidField(path, field, "a boolean or null");
  }
  if (shape.process !== null) {
    if (!record(shape.process) || Object.keys(shape.process).some((key) => key !== "pid" && key !== "executable")) return invalidField(path, "process", "a process identity or null");
    if (!integer(shape.process.pid) || !nullableString(shape.process.executable)) return invalidField(path, "process", "a process identity or null");
  }
}

function validateTaskItems(value: unknown, path: string, fields: string[]): ProbeParseResult | undefined {
  if (!Array.isArray(value)) return fail(path, "must be an array");
  for (let index = 0; index < value.length; index++) {
    const item = value[index];
    if (!record(item)) return fail(`${path}[${index}]`, "must be an object");
    const extra = unknownKey(item, new Set(fields));
    if (extra) return fail(`${path}[${index}].${extra}`, `unknown key: ${extra}`);
    const missing = requireKeys(item, fields, `${path}[${index}]`);
    if (missing) return missing;
    if (!string(item.type)) return fail(`${path}[${index}].type`, "type must be a string");
    for (const field of fields.filter((field) => field !== "type" && field !== "enabled")) {
      if (!nullableString(item[field])) return fail(`${path}[${index}].${field}`, `${field} must be a string or null`);
    }
    if (fields.includes("enabled") && !nullableBoolean(item.enabled)) return fail(`${path}[${index}].enabled`, "enabled must be a boolean or null");
  }
}

function validateScheduledTask(value: unknown, path: string): ProbeParseResult | undefined {
  const shape = validateShape(value, path, ["name", "state", "principal", "runLevel", "triggers", "actions", "executionTimeLimit"]);
  if (isFailure(shape)) return shape;
  if (!string(shape.name)) return invalidField(path, "name", "a string");
  if (!TASK_STATES.has(shape.state as ScheduledTaskState)) return invalidField(path, "state", "a normalized scheduled-task state");
  for (const field of ["principal", "runLevel", "executionTimeLimit"] as const) {
    if (!nullableString(shape[field])) return invalidField(path, field, "a string or null");
  }
  return validateTaskItems(shape.triggers, `${path}.triggers`, ["type", "enabled", "startBoundary"])
    ?? validateTaskItems(shape.actions, `${path}.actions`, ["type", "execute", "arguments", "workingDirectory"]);
}

function validateSystemdUnit(value: unknown, path: string): ProbeParseResult | undefined {
  const fields = ["name", "loadState", "activeState", "subState", "unitFileState", "mainPid", "fragmentPath"];
  const shape = validateShape(value, path, fields);
  if (isFailure(shape)) return shape;
  for (const field of ["name", "loadState", "activeState", "subState"] as const) {
    if (!string(shape[field])) return invalidField(path, field, "a string");
  }
  for (const field of ["unitFileState", "fragmentPath"] as const) {
    if (!nullableString(shape[field])) return invalidField(path, field, "a string or null");
  }
  if (!nullableInteger(shape.mainPid)) return invalidField(path, "mainPid", "a non-negative integer or null");
}

export function parseProbeResult(input: unknown): ProbeParseResult {
  if (!record(input)) return fail("$", "probe result must be an object");
  const extra = unknownKey(input, ENVELOPE_KEYS);
  if (extra) return fail(`$.${extra}`, `unknown key: ${extra}`);
  if (input.version !== PROBE_SCHEMA_VERSION) return fail("$.version", `version must be ${PROBE_SCHEMA_VERSION}`);
  if (!NOUNS.has(input.noun as ProbeNoun)) return fail("$.noun", "unsupported probe noun");
  if (!PLATFORMS.has(input.platform as OS)) return fail("$.platform", "unsupported platform");
  if (input.noun === "scheduled-task" && input.platform !== "windows") return fail("$.platform", "scheduled-task probes require windows");
  if (input.noun === "systemd-unit" && input.platform !== "linux") return fail("$.platform", "systemd-unit probes require linux");
  if (typeof input.found !== "boolean") return fail("$.found", "found must be a boolean");
  if (!SOURCE_STATUSES.has(input.status as ProbeSource["status"])) return fail("$.status", "unsupported probe status");
  if (input.status === "found" && input.found !== true) return fail("$.found", "found status requires found to be true");
  if (input.status !== "found" && input.found !== false) return fail("$.found", `${String(input.status)} status requires found to be false`);
  if (typeof input.source !== "string" || input.source.length === 0) return fail("$.source", "source must be a non-empty string");
  if (input.raw !== undefined && !record(input.raw)) return fail("$.raw", "raw must be an object");
  if (!Array.isArray(input.warnings) || input.warnings.some((warning) => typeof warning !== "string")) {
    return fail("$.warnings", "warnings must be an array of strings");
  }

  if (input.status !== "found") {
    if (input.normalized !== null) return fail("$.normalized", `${input.status} status requires normalized to be null`);
    return { ok: true, result: input as ProbeResult };
  }

  const path = "$.normalized";
  const error = input.noun === "process" ? validateProcess(input.normalized, path)
    : input.noun === "port" ? validatePort(input.normalized, path)
    : input.noun === "file" ? validateFile(input.normalized, path)
    : input.noun === "service" ? validateService(input.normalized, path)
    : input.noun === "scheduled-task" ? validateScheduledTask(input.normalized, path)
    : validateSystemdUnit(input.normalized, path);
  if (error) return error;
  return { ok: true, result: input as ProbeResult };
}
