import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureEvidenceEnvironment,
  createEvidenceManifest,
  createStepEvidenceSink,
  EVIDENCE_SCHEMA_VERSION,
  REDACTED_VALUE,
  redactSensitiveValues,
  serializeEvidenceManifest,
  STEP_EVIDENCE_FILENAME,
  type EvidenceManifestInput,
} from "../src/evidence.ts";
import {
  runScenario,
  SCENARIO_SCHEMA_VERSION,
  type Scenario,
} from "../src/scenario.ts";
import type { ScenarioStepEvent } from "../src/scenario-run.ts";

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

describe("step evidence ledger", () => {
  test("appends ordered, deterministic, recursively redacted lifecycle events", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "cuse-evidence-"));
    try {
      const sink = await createStepEvidenceSink(evidenceRoot);
      const scenario: Scenario = {
        version: SCENARIO_SCHEMA_VERSION,
        name: "evidence sink test",
        vars: {},
        defaultTimeoutMs: 1_000,
        steps: [{
          type: "cuse",
          action: "synthetic",
          options: {
            apiToken: "fake-injected-value",
            nested: [{ password: "fake-injected-value" }],
          },
        }],
      };

      await runScenario(scenario, {
        invokeCuse: async () => ({
          ok: true,
          data: { credentials: "fake-injected-value", result: "preserved" },
        }),
        onStepEvent: sink,
      });

      const persisted = await readFile(join(evidenceRoot, STEP_EVIDENCE_FILENAME), "utf8");
      const lines = persisted.trimEnd().split("\n");
      const events = lines.map((line) => JSON.parse(line) as ScenarioStepEvent);

      expect(lines).toHaveLength(2);
      expect(persisted.endsWith("\n")).toBe(true);
      expect(events.map((event) => event.type)).toEqual(["start", "terminal"]);
      expect(persisted).not.toContain("fake-injected-value");
      expect(persisted.match(new RegExp(REDACTED_VALUE.replace(/[\[\]]/g, "\\$&"), "g")))
        .toHaveLength(5);
      expect(lines[0]).toStartWith('{"index":0,"phase":"steps","step":');
      expect(events[1]).toMatchObject({
        type: "terminal",
        result: { cuse: { data: { credentials: REDACTED_VALUE, result: "preserved" } } },
      });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  test("serializes equivalent events identically regardless of insertion order", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "cuse-evidence-ordering-"));
    try {
      const sink = await createStepEvidenceSink(evidenceRoot);
      const first: ScenarioStepEvent = {
        type: "start",
        phase: "steps",
        index: 0,
        step: { type: "cuse", action: "synthetic", options: { z: "last", a: "first" } },
      };
      const second: ScenarioStepEvent = {
        index: 0,
        phase: "steps",
        step: { options: { a: "first", z: "last" }, action: "synthetic", type: "cuse" },
        type: "start",
      };

      await sink(first);
      await sink(second);

      const lines = (await readFile(join(evidenceRoot, STEP_EVIDENCE_FILENAME), "utf8"))
        .trimEnd().split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(lines[1]);
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });

  test("persists partial stdout from a timed-out terminal event", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "cuse-evidence-timeout-"));
    try {
      const sink = await createStepEvidenceSink(evidenceRoot);
      const scenario: Scenario = {
        version: SCENARIO_SCHEMA_VERSION,
        name: "timeout evidence test",
        vars: {},
        defaultTimeoutMs: 100,
        steps: [{
          type: "wait",
          intervalMs: 100,
          step: {
            type: "exec",
            argv: [
              process.execPath,
              "-e",
              "process.stdout.write('partial output'); process.exit(1)",
            ],
          },
        }],
      };

      await runScenario(scenario, { onStepEvent: sink });

      const lines = (await readFile(join(evidenceRoot, STEP_EVIDENCE_FILENAME), "utf8"))
        .trimEnd().split("\n");
      const terminal = JSON.parse(lines[1]!) as ScenarioStepEvent;
      expect(terminal).toMatchObject({
        type: "terminal",
        result: {
          status: "timed_out",
          timedOut: true,
          run: { stdout: "partial output" },
        },
      });
    } finally {
      await rm(evidenceRoot, { recursive: true, force: true });
    }
  });
});
