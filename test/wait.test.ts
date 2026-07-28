import { test, expect, describe } from "bun:test";
import {
  describeTarget, targetIsUsable, isSatisfied, remaining, nextGap,
  timeoutReason, successDetail,
} from "../src/wait.ts";
import { blindNote } from "../src/session.ts";

describe("what is being waited for", () => {
  test("a control by name", () => {
    expect(describeTarget({ element: "Save" })).toBe("a control named 'Save'");
  });
  test("a control by role and name", () => {
    expect(describeTarget({ element: "Save", role: "button" })).toBe("a control role 'button' named 'Save'");
  });
  test("a window", () => {
    expect(describeTarget({ window: "target.txt" })).toBe("a window matching 'target.txt'");
  });
  test("a wait with no target is refused rather than waiting forever on nothing", () => {
    expect(targetIsUsable({})).toBe(false);
    expect(targetIsUsable({ window: "x" })).toBe(true);
    expect(targetIsUsable({ role: "button" })).toBe(true);
  });
});

describe("when to stop looking", () => {
  test("waiting for something ends when it is found", () => {
    expect(isSatisfied(true, false)).toBe(true);
    expect(isSatisfied(false, false)).toBe(false);
  });
  test("waiting for it to go ends when it is not found", () => {
    expect(isSatisfied(false, true)).toBe(true);
    expect(isSatisfied(true, true)).toBe(false);
  });
  test("--gone on something that was never there is satisfied, not a trick", () => {
    // An agent that closed a dialog should not have to prove it existed first.
    expect(isSatisfied(false, true)).toBe(true);
  });
});

describe("the schedule", () => {
  test("time left is never negative, so nothing sleeps past the deadline", () => {
    expect(remaining(1000, 1500)).toBe(0);
    expect(remaining(1000, 400)).toBe(600);
  });
  test("the last gap shrinks to what is left rather than overshooting", () => {
    expect(nextGap(1000, 900, 400)).toBe(100);
    expect(nextGap(1000, 100, 400)).toBe(400);
    expect(nextGap(1000, 1000, 400)).toBe(0);
  });
});

describe("what the caller is told", () => {
  test("a timeout names the target and what was there instead", () => {
    const msg = timeoutReason({ element: "Save" }, false, 3000, "button 'Cancel', label 'Done'");
    expect(msg).toContain("named 'Save'");
    expect(msg).toContain("never appeared after 3000ms");
    expect(msg).toContain("Cancel");
  });
  test("a --gone timeout says it was still there, not that it never appeared", () => {
    expect(timeoutReason({ window: "dialog" }, true, 500, "dialog")).toContain("was still there");
  });
  test("success says how long and how many looks", () => {
    expect(successDetail({ window: "target" }, false, 1200, 3)).toBe(
      "a window matching 'target' appeared after 1200ms (3 looks)");
  });
  test("one look is singular, because sloppy plurals read as machine output", () => {
    expect(successDetail({ window: "t" }, false, 10, 1)).toContain("(1 look)");
  });
});

describe("an empty screen versus a screen you cannot see", () => {
  test("a locked session explains an empty list", () => {
    expect(blindNote(true, true)).toContain("screen is locked");
  });
  test("an unlocked session with nothing on it gets no excuse", () => {
    expect(blindNote(false, true)).toBeUndefined();
  });
  test("an unreadable lock state is not turned into a claim", () => {
    expect(blindNote(null, true)).toBeUndefined();
  });
  test("a list with things in it needs no note either way", () => {
    expect(blindNote(true, false)).toBeUndefined();
  });
});
