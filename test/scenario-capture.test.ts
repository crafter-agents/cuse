import { describe, expect, test } from "bun:test";
import { detectClickEdges } from "../src/scenario-capture.ts";

type Poll = () => void;

function fakeSchedule() {
  let poll: Poll = () => {};
  return {
    schedule: (next: Poll) => {
      poll = next;
      return 1 as unknown as ReturnType<typeof setInterval>;
    },
    cancel: () => {},
    tick: () => poll(),
  };
}

describe("click edge detection", () => {
  test("reports one click for a false-to-true transition", () => {
    const timer = fakeSchedule();
    let pressed = false;
    const clicks: Array<{ point: { x: number; y: number }; timestampMs: number }> = [];
    const capture = detectClickEdges({
      pollButtonState: () => pressed,
      pollMouseLocation: () => ({ x: 120, y: 45 }),
      intervalMs: 20,
      now: () => 1234,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onClick: (point, timestampMs) => clicks.push({ point, timestampMs }),
    });

    timer.tick();
    pressed = true;
    timer.tick();
    timer.tick();
    capture.stop();

    expect(clicks).toEqual([{ point: { x: 120, y: 45 }, timestampMs: 1234 }]);
  });

  test.each([false, true])("reports no clicks when state stays %s", (pressed) => {
    const timer = fakeSchedule();
    const clicks: unknown[] = [];
    const capture = detectClickEdges({
      pollButtonState: () => pressed,
      pollMouseLocation: () => ({ x: 0, y: 0 }),
      intervalMs: 20,
      schedule: timer.schedule,
      cancel: timer.cancel,
      onClick: (...args) => clicks.push(args),
    });

    timer.tick();
    timer.tick();
    capture.stop();

    expect(clicks).toEqual([]);
  });
});
