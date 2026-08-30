import { resolveHitElement, type Element, type HitPoint } from "./elements.ts";
import type { ScenarioStep } from "./scenario.ts";

export type RecordedClickEvent = {
  point: HitPoint;
  timestampMs: number;
  elements: Element[];
};

export type RecordedClickConversionOptions = {
  settleGapMs?: number;
};

const DEFAULT_SETTLE_GAP_MS = 1_000;

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
