import { describe, expect, test } from "bun:test";
import {
  captureEvidenceEnvironment,
  createEvidenceManifest,
  EVIDENCE_SCHEMA_VERSION,
  REDACTED_VALUE,
  redactSensitiveValues,
  serializeEvidenceManifest,
  type EvidenceManifestInput,
} from "../src/evidence.ts";

const manifestInput = (): EvidenceManifestInput => ({
  scenario: { name: "synthetic scenario" },
  os: "test-os",
  architecture: "test-arch",
  startedAt: "2026-01-01T00:00:00.000Z",
  endedAt: "2026-01-01T00:00:01.000Z",
  cuseVersion: "0.0.0-test",
  finalVerdict: "passed",
  gaps: [],
  artifacts: [],
  environment: { CI: "true", LANG: "en_US.UTF-8" },
});

describe("evidence manifest", () => {
  test("constructs and serializes deterministic versioned output", () => {
    const first = createEvidenceManifest(manifestInput());
    const second = createEvidenceManifest({
      ...manifestInput(),
      environment: { LANG: "en_US.UTF-8", CI: "true" },
    });

    expect(first.schemaVersion).toBe(EVIDENCE_SCHEMA_VERSION);
    expect(serializeEvidenceManifest(first)).toBe(serializeEvidenceManifest(second));
    expect(serializeEvidenceManifest(first)).toBe(serializeEvidenceManifest(first));
  });

  test("captures only explicitly allowlisted environment metadata", () => {
    const captured = captureEvidenceEnvironment({
      CI: "true",
      LANG: "en_US.UTF-8",
      TERM_PROGRAM: "synthetic-terminal",
      UNLISTED_METADATA: "not persisted",
      API_TOKEN: "fake-injected-value",
    });

    expect(captured).toEqual({
      CI: "true",
      LANG: "en_US.UTF-8",
      TERM_PROGRAM: "synthetic-terminal",
    });
    expect(JSON.stringify(captured)).not.toContain("fake-injected-value");
  });

  test("recursively redacts sensitive keys in objects and arrays", () => {
    const redacted = redactSensitiveValues({
      token: "fake-injected-value",
      nested: {
        API_SECRET: "fake-injected-value",
        Password: "fake-injected-value",
        credentials: "fake-injected-value",
        privateKey: "fake-injected-value",
        public: "preserved",
      },
      entries: [
        { access_token: "fake-injected-value", label: "preserved" },
        { API_KEY: "fake-injected-value", count: 2 },
      ],
    });

    expect(redacted).toEqual({
      token: REDACTED_VALUE,
      nested: {
        API_SECRET: REDACTED_VALUE,
        Password: REDACTED_VALUE,
        credentials: REDACTED_VALUE,
        privateKey: REDACTED_VALUE,
        public: "preserved",
      },
      entries: [
        { access_token: REDACTED_VALUE, label: "preserved" },
        { API_KEY: REDACTED_VALUE, count: 2 },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain("fake-injected-value");
  });

  test("redacts before manifest serialization", () => {
    const manifest = createEvidenceManifest({
      ...manifestInput(),
      environment: { CI: "true" },
      scenario: {
        name: "synthetic scenario",
        apiToken: "fake-injected-value",
      },
    });

    const serialized = serializeEvidenceManifest(manifest);
    expect(serialized).toContain(`"apiToken": "${REDACTED_VALUE}"`);
    expect(serialized).not.toContain("fake-injected-value");
  });
});
