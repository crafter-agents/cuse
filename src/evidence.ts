export const EVIDENCE_SCHEMA_VERSION = 1 as const;
export const REDACTED_VALUE = "[REDACTED]" as const;

export const EVIDENCE_ENVIRONMENT_ALLOWLIST = [
  "CI",
  "GITHUB_ACTIONS",
  "LANG",
  "LC_ALL",
  "TERM_PROGRAM",
] as const;

export type EvidenceJsonValue =
  | null
  | boolean
  | number
  | string
  | EvidenceJsonValue[]
  | { [key: string]: EvidenceJsonValue };

export type EvidenceVerdict = "passed" | "failed" | "skipped" | "error";

export type EvidenceScenario = {
  name: string;
  [key: string]: EvidenceJsonValue;
};

export type EvidenceGap = {
  code: string;
  message: string;
};

export type EvidenceArtifact = {
  path: string;
  kind: string;
};

export type EvidenceManifest = {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  scenario: EvidenceScenario;
  os: string;
  architecture: string;
  startedAt: string;
  endedAt: string;
  cuseVersion: string;
  finalVerdict: EvidenceVerdict;
  gaps: EvidenceGap[];
  artifacts: EvidenceArtifact[];
  environment: Record<string, string>;
};

export type EvidenceManifestInput = Omit<EvidenceManifest, "schemaVersion">;

const SENSITIVE_KEY = /(?:token|secret|password|credential|(?:api|access|client|private|public|signing|encryption)[_-]?key)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSensitiveKey(key: string): boolean {
  return key.toLowerCase() === "key" || SENSITIVE_KEY.test(key);
}

export function redactSensitiveValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactSensitiveValues) as T;
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      isSensitiveKey(key) ? REDACTED_VALUE : redactSensitiveValues(child),
    ]),
  ) as T;
}

export function captureEvidenceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const captured: Record<string, string> = {};
  for (const key of EVIDENCE_ENVIRONMENT_ALLOWLIST) {
    const value = environment[key];
    if (value !== undefined) captured[key] = value;
  }
  return captured;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;

  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

export function createEvidenceManifest(input: EvidenceManifestInput): EvidenceManifest {
  return redactSensitiveValues({
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    ...input,
  });
}

export function serializeEvidenceManifest(manifest: EvidenceManifest): string {
  return JSON.stringify(sortJson(redactSensitiveValues(manifest)), null, 2);
}
