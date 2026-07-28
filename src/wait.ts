// Waiting for a thing to appear, or to go away.
//
// Every script that drives a desktop is full of sleeps, and each one is a guess
// that is either too short on a slow machine or wasted time on a fast one. The
// CI for this repo had a hand-rolled version of exactly this loop - poll the
// window list until the document shows up - which is the usual sign that a tool
// is missing a verb.
//
// What is worth having as pure functions here is not the sleeping, it is the
// decision and the message: an agent that times out needs to be told what was
// being waited for and what was there instead.

export type WaitTarget = { element?: string; role?: string; window?: string };

/** What are we waiting for, in words an agent can log or hand back to a user. */
export function describeTarget(t: WaitTarget): string {
  if (t.element || t.role) {
    const bits = [t.role && `role '${t.role}'`, t.element && `named '${t.element}'`].filter(Boolean);
    return `a control ${bits.join(" ")}`.trim();
  }
  if (t.window) return `a window matching '${t.window}'`;
  return "nothing in particular";
}

/** A target is only well formed if it says what to look for. */
export function targetIsUsable(t: WaitTarget): boolean {
  return Boolean(t.element || t.role || t.window);
}

/**
 * Are we done?
 *
 * `gone` inverts the question, and the asymmetry matters: waiting for something
 * to appear ends the moment it does, while waiting for it to disappear ends the
 * moment it stops being found - including when it was never there, which is a
 * legitimate answer rather than a trick.
 */
export function isSatisfied(found: boolean, gone: boolean): boolean {
  return gone ? !found : found;
}

/** How long is left, never negative, so a caller cannot sleep past the deadline. */
export function remaining(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

/** The gap before the next look: the poll interval, or whatever time is left. */
export function nextGap(deadline: number, now: number, gapMs: number): number {
  return Math.min(gapMs, remaining(deadline, now));
}

/**
 * Why the wait ended badly, with what was actually on screen.
 *
 * A timeout that says only "timed out" forces the agent to go and look, which
 * is the call it just made.
 */
export function timeoutReason(t: WaitTarget, gone: boolean, ms: number, sample: string): string {
  const what = describeTarget(t);
  const verb = gone ? "was still there" : "never appeared";
  return `${what} ${verb} after ${ms}ms${sample ? ` - what is there: ${sample}` : ""}`;
}

/** What the caller gets when it worked: how long it took, and how many looks. */
export function successDetail(t: WaitTarget, gone: boolean, ms: number, looks: number): string {
  const what = describeTarget(t);
  return `${what} ${gone ? "went away" : "appeared"} after ${ms}ms ` +
    `(${looks} look${looks === 1 ? "" : "s"})`;
}
