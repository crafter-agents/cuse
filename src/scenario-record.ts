import { resolveHitElement, type Element, type HitPoint } from "./elements.ts";
import type { ScenarioStep } from "./scenario.ts";
import { buildScenarioDraft, serializeScenario } from "./scenario-write.ts";

export type RecordedClickEvent = {
  point: HitPoint;
  timestampMs: number;
  elements: Element[];
};

export type RecordedClickConversionOptions = {
  settleGapMs?: number;
};

const DEFAULT_SETTLE_GAP_MS = 1_000;

type ScenarioDraftFromRecordedEventsOptions = {
  name?: string;
  vars?: Record<string, unknown>;
};

export type ScenarioDraftFromRecordedEventsResult =
  | { ok: true; serialized: string }
  | { ok: false; error: string };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isElement(value: unknown): value is Element {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const element = value as Record<string, unknown>;
  return typeof element.role === "string" &&
    typeof element.rawRole === "string" &&
    typeof element.name === "string" &&
    isFiniteNumber(element.x) &&
    isFiniteNumber(element.y) &&
    isFiniteNumber(element.width) &&
    isFiniteNumber(element.height);
}

function isRecordedClickEvent(value: unknown): value is RecordedClickEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  if (typeof event.point !== "object" || event.point === null || Array.isArray(event.point)) {
    return false;
  }
  const point = event.point as Record<string, unknown>;
  return isFiniteNumber(point.x) &&
    isFiniteNumber(point.y) &&
    isFiniteNumber(event.timestampMs) &&
    Array.isArray(event.elements) &&
    event.elements.every(isElement);
}

function clickStep(event: RecordedClickEvent): ScenarioStep {
  const element = resolveHitElement(event.elements, event.point);
  if (element) {
    return {
      type: "cuse",
      action: "click",
      options: { element: element.name },
    };
  }

  return {
    type: "cuse",
    action: "click",
    args: [String(event.point.x), String(event.point.y)],
    name: "Coordinate fallback click",
  };
}

export function recordedClicksToScenarioSteps(
  events: RecordedClickEvent[],
  options?: RecordedClickConversionOptions,
): ScenarioStep[] {
  // A gap over 1,000 ms suggests the UI had time to keep moving between clicks.
  const settleGapMs = options?.settleGapMs ?? DEFAULT_SETTLE_GAP_MS;
  const steps: ScenarioStep[] = [];

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const previous = events[index - 1];
    if (previous && event.timestampMs - previous.timestampMs > settleGapMs) {
      steps.push({ type: "cuse", action: "settle" });
    }
    steps.push(clickStep(event));
  }

  return steps;
}

export function buildScenarioDraftFromRecordedEvents(
  input: unknown,
  opts?: ScenarioDraftFromRecordedEventsOptions,
): ScenarioDraftFromRecordedEventsResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "recorded events must be an array" };
  }

  const invalidIndex = input.findIndex((event) => !isRecordedClickEvent(event));
  if (invalidIndex !== -1) {
    return {
      ok: false,
      error: `recorded event at index ${invalidIndex} must have a point, timestampMs, and elements`,
    };
  }

  try {
    const steps = recordedClicksToScenarioSteps(input);
    const scenario = buildScenarioDraft(opts?.name ?? "recorded scenario", steps, {
      vars: opts?.vars,
      defaultTimeoutMs: 5_000,
    });
    return { ok: true, serialized: serializeScenario(scenario) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
