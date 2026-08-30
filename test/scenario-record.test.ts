import { describe, expect, test } from "bun:test";
import type { Element } from "../src/elements.ts";
import {
  buildScenarioDraftFromRecordedEvents,
  recordedClicksToScenarioSteps,
} from "../src/scenario-record.ts";
import { parseScenario } from "../src/scenario.ts";
import { buildScenarioDraft, serializeScenario } from "../src/scenario-write.ts";

const elements: Element[] = [
  { role: "window", rawRole: "window", name: "Document", x: 0, y: 0, width: 800, height: 600 },
  { role: "button", rawRole: "button", name: "Save", x: 700, y: 20, width: 80, height: 40 },
];

describe("recorded clicks to scenario steps", () => {
  test("targets the most specific accessibility identity under the click", () => {
    const steps = recordedClicksToScenarioSteps([
      { point: { x: 720, y: 30 }, timestampMs: 0, elements },
    ]);

    expect(steps).toEqual([
      { type: "cuse", action: "click", options: { element: "Save" } },
    ]);
  });

  test("visibly marks a coordinate fallback when no element contains the point", () => {
    const steps = recordedClicksToScenarioSteps([
      { point: { x: 900, y: 650 }, timestampMs: 0, elements },
    ]);

    expect(steps).toEqual([
      {
        type: "cuse",
        action: "click",
        args: ["900", "650"],
        name: "Coordinate fallback click",
      },
    ]);
    expect(steps[0]?.name).toMatch(/fallback|coordinate/i);
  });

  test("inserts settle only when the gap exceeds the threshold", () => {
    const event = (timestampMs: number) => ({
      point: { x: 720, y: 30 },
      timestampMs,
      elements,
    });

    expect(recordedClicksToScenarioSteps([event(0), event(1_000)])).toHaveLength(2);
    expect(recordedClicksToScenarioSteps([event(0), event(1_001)])).toEqual([
      { type: "cuse", action: "click", options: { element: "Save" } },
      { type: "cuse", action: "settle" },
      { type: "cuse", action: "click", options: { element: "Save" } },
    ]);
  });

  test("round-trips generated steps through the existing scenario writer and parser", () => {
    const steps = recordedClicksToScenarioSteps([
      { point: { x: 720, y: 30 }, timestampMs: 0, elements },
      { point: { x: 900, y: 650 }, timestampMs: 1_500, elements },
    ]);
    const serialized = serializeScenario(
      buildScenarioDraft("recorded clicks", steps, { defaultTimeoutMs: 5_000 }),
    );
    const parsed = parseScenario(JSON.parse(serialized));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.scenario.steps).toEqual(steps);
      expect(parsed.scenario.steps.every((step) =>
        ["cuse", "exec", "json", "assert", "wait"].includes(step.type)
      )).toBe(true);
    }
  });
});

describe("scenario draft from recorded events", () => {
  const events = [
    { point: { x: 720, y: 30 }, timestampMs: 0, elements },
    { point: { x: 900, y: 650 }, timestampMs: 1_500, elements },
  ];

  test("serializes the same steps as the recorded click converter", () => {
    const result = buildScenarioDraftFromRecordedEvents(events, { name: "saved flow" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = parseScenario(JSON.parse(result.serialized));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.scenario.steps).toEqual(recordedClicksToScenarioSteps(events));
      }
    }
  });

  test("rejects non-array input without throwing", () => {
    expect(buildScenarioDraftFromRecordedEvents({ events })).toEqual({
      ok: false,
      error: "recorded events must be an array",
    });
  });

  test("uses the default scenario name", () => {
    const result = buildScenarioDraftFromRecordedEvents(events);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const parsed = parseScenario(JSON.parse(result.serialized));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.scenario.name).toBe("recorded scenario");
    }
  });
});
