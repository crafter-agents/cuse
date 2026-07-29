#!/usr/bin/env bun
// cuse - cross-platform computer-use CLI. One verb, the right OS primitive.
// Structured Result + --json. Actions delegate to pure builders (tested).

import { resolve } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { detectOS, chordToOS, type OS } from "./os.ts";
import { captureCmd, typeCmd, launchCmd, focusCmd, comboKey } from "./commands.ts";
import { movePlan, clickPlan, scrollPlan, type Plan } from "./plan.ts";
import { preflight, frameWarning, INPUT_ACTIONS, type Probe } from "./preflight.ts";
import { isSessionLocked, blindNote, LOCK_QUERY, LOCKED_REASON } from "./session.ts";
import { decodePNG, diffImages, isUniform, readHeader, type Image } from "./png.ts";
import { runWithTimeout, runBytes, explainFailure, timeoutFor } from "./exec.ts";
import { encodePNG } from "./png.ts";
import { decodeXWD } from "./xwd.ts";
import { listWindowsCmd, parseWindows, pickWindow, pointIn, frontmostCmd, parseFrontmost,
         frontmostMatches, type Win } from "./window.ts";
import { findTemplate, crop, variance, MIN_VARIANCE } from "./match.ts";
import { elementsCmd, parseElements, pickElement, pointInElement, describeMisses,
         geometryLooksUsable, type Element } from "./elements.ts";
import { displaysCmd, parseDisplays, frameOrigin, coverageWarning, toScreenPoint,
         desktopBounds, type Display } from "./display.ts";
import { parseArgs, tokenize, withSession, type Session } from "./args.ts";
import { describeTarget, targetIsUsable, isSatisfied, nextGap, timeoutReason,
         successDetail, type WaitTarget } from "./wait.ts";

export type Options = {
  force?: boolean; sameUnder?: number; timeoutMs?: number;
  /** aim at a window by title instead of at absolute coordinates */
  window?: string;
  /** aim at whatever matches this template image */
  find?: string;
  /** where inside the target to aim, as fractions of its size */
  at?: [number, number];
  minScore?: number;
  /** refuse to send input unless this is the frontmost window */
  expectFront?: string;
  /** aim at a control by its accessibility name */
  element?: string;
  /** narrow that to a kind of control: button, text, checkbox, ... */
  role?: string;
  /** which application's controls to look at */
  app?: string;
  /** wait for the target to disappear rather than to appear */
  gone?: boolean;
  /** which screen to capture, 1-based, where the platform can pick one */
  display?: number;
};

export type Result = {
  ok: boolean; action: string; os: OS;
  detail?: string; error?: string; warn?: string; data?: unknown;
};

/**
 * Run a command under a deadline, and on failure report what the OS said.
 *
 * Both halves matter. Bun's default throw carries only an exit code, which
 * turns "no window matching 'Notepad'" into "Failed with exit code 1"; and
 * without a timeout a wedged backend hangs the agent driving cuse, which has no
 * deadline of its own.
 */
function runner(action: string, timeoutMs: number) {
  return async function run(argv: string[]): Promise<void> {
    const r = await runWithTimeout(argv, timeoutMs);
    const problem = explainFailure(argv, r, timeoutMs);
    if (problem) throw new Error(problem);
  };
}

/** Execute a plan. The macOS branch is loaded lazily so that importing the CLI
 *  on Linux or Windows never touches bun:ffi or a framework that is not there. */
async function execute(plan: Plan, run: (argv: string[]) => Promise<void>): Promise<void> {
  switch (plan.kind) {
    case "exec": return run(plan.argv);
    case "exec-many": { for (const a of plan.argvs) await run(a); return; }
    case "native": {
      const mac = await import("./macos.ts");
      if (plan.op === "warp") return mac.warp(plan.x, plan.y);
      if (plan.op === "click") return mac.click(plan.count, plan.x, plan.y);
      return mac.scroll(plan.lines);
    }
  }
}

const inflate = (d: Uint8Array) => new Uint8Array(inflateSync(d));
const deflate = (d: Uint8Array) => new Uint8Array(deflateSync(d));

/**
 * Take a screenshot, whatever the platform's backend emits.
 *
 * macOS and Windows write a PNG themselves. Linux hands back an xwd dump on
 * stdout, which cuse converts - that is what removes the imagemagick dependency.
 */
async function captureTo(os: OS, out: string, timeoutMs: number,
                         run: (argv: string[]) => Promise<void>,
                         display?: number): Promise<void> {
  const plan = captureCmd(os, out, display);
  if (plan.output === "file") return run(plan.argv);
  const r = await runBytes(plan.argv, timeoutMs);
  const problem = explainFailure(plan.argv, r, timeoutMs);
  if (problem) throw new Error(problem);
  if (r.stdout.length === 0) throw new Error(`${plan.argv[0]} produced no dump (is DISPLAY reachable?)`);
  await Bun.write(out, encodePNG(decodeXWD(r.stdout), deflate));
}

async function loadImage(path: string): Promise<Image> {
  return decodePNG(new Uint8Array(await Bun.file(path).arrayBuffer()), inflate);
}

/** Look at the frame that was just captured and say whether it is worth acting on. */
async function inspectFrame(path: string, bytes: number): Promise<string | undefined> {
  const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
  const header = readHeader(raw);
  try {
    // Exact answer when the frame decodes: every pixel identical or not.
    return frameWarning({ uniform: isUniform(decodePNG(raw, inflate)), bytes, ...header! });
  } catch {
    // Formats the decoder refuses still get the size-based estimate.
    return header ? frameWarning({ bytes, ...header }) : undefined;
  }
}

const probe: Probe = { env: process.env, has: (tool) => Bun.which(tool) !== null };

/** Ask the OS whether the screen is locked; null when it cannot be asked. */
async function readLockState(os: OS): Promise<string | null> {
  const query = LOCK_QUERY[os];
  if (!query) return null;
  // Short deadline of its own: an unanswerable lock query must not delay the
  // action it guards. Unreadable means unknown, and unknown never blocks.
  const r = await runWithTimeout(query, 5000);
  return r.code === 0 && !r.timedOut ? r.stdout : null;
}

/** Does this capture hold every screen? Answered from the file that was written. */
async function captureCoverage(os: OS, path: string, timeoutMs: number,
                               display?: number): Promise<string | undefined> {
  const displays = await listDisplays(os, timeoutMs);
  if (displays.length < 2) return undefined;
  const header = readHeader(new Uint8Array(await Bun.file(path).arrayBuffer()));
  if (!header) return undefined;
  const scale = await pointScale(os, header.width);
  const origin = frameOrigin(displays, os, display);
  return coverageWarning(displays, {
    ...origin,
    width: Math.round(header.width / scale), height: Math.round(header.height / scale),
  });
}

/** Ask the platform's accessibility tree for an application's controls. */
async function listElements(os: OS, app: string, timeoutMs: number): Promise<Element[]> {
  const argv = elementsCmd(os, app);
  const r = await runWithTimeout(argv, timeoutMs);
  const problem = explainFailure(argv, r, timeoutMs);
  if (problem) throw new Error(problem);
  return parseElements(r.stdout, os);
}

/**
 * What screens are attached.
 *
 * Never fatal: a machine that cannot answer this still has a screen, and the
 * single-display assumption that held before is the right fallback. What is not
 * acceptable is silently acting on it when the answer was available.
 */
async function listDisplays(os: OS, timeoutMs: number): Promise<Display[]> {
  try {
    const r = await runWithTimeout(displaysCmd(os), Math.min(timeoutMs, 10_000));
    if (r.code !== 0 || r.timedOut) return [];
    return parseDisplays(r.stdout, os);
  } catch { return []; }
}

/** Ask the OS what windows exist, and parse whatever shape it answers in. */
async function listWindows(os: OS, timeoutMs: number): Promise<Win[]> {
  const argv = listWindowsCmd(os);
  const r = await runWithTimeout(argv, timeoutMs);
  const problem = explainFailure(argv, r, timeoutMs);
  if (problem) throw new Error(problem);
  return parseWindows(r.stdout);
}

/**
 * Turn an intention into a coordinate.
 *
 * This is the piece that makes cuse usable by an agent that has a screenshot
 * rather than a coordinate: aim at a window by name, or at a picture of the
 * thing to press, and cuse works out where that is right now.
 */
async function resolveTarget(os: OS, opts: Options, timeoutMs: number,
                             run: (argv: string[]) => Promise<void>): Promise<{ x: number; y: number; how: string }> {
  const [fx, fy] = opts.at ?? [0.5, 0.5];

  // A name beats a picture: it survives a theme, a font, a window that moved.
  if (opts.element || opts.role) {
    const els = await listElements(os, opts.app ?? opts.window ?? "", timeoutMs);
    const sel = { name: opts.element, role: opts.role };
    if (!geometryLooksUsable(els)) {
      throw new Error(
        `the accessibility tree reports ${els.length} controls but places them all at 0,0 - ` +
        `its coordinates cannot be aimed at`);
    }
    const hit = pickElement(els, sel);
    if (!hit) {
      throw new Error(
        `no control matching ${opts.element ? `'${opts.element}'` : ""}` +
        `${opts.role ? ` of role '${opts.role}'` : ""} - ` +
        `what is there: ${describeMisses(els, sel)}`);
    }
    const p = pointInElement(hit, fx, fy);
    return { ...p, how: `${hit.role} '${hit.name}' (${hit.width}x${hit.height} at ${hit.x},${hit.y})` };
  }

  if (opts.window) {
    const wins = await listWindows(os, timeoutMs);
    const w = pickWindow(wins, opts.window);
    if (!w) {
      const seen = wins.map((v) => v.title).filter(Boolean).slice(0, 8).join(", ") || "none";
      throw new Error(`no window matching '${opts.window}' (visible windows: ${seen})`);
    }
    const p = pointIn(w, fx, fy);
    return { ...p, how: `${w.title} at ${Math.round(fx * 100)}%,${Math.round(fy * 100)}%` };
  }
  if (opts.find) {
    const shot = resolve("find-frame.png");
    await captureTo(os, shot, timeoutMs, run, opts.display);
    const hay = await loadImage(shot);
    const needle = await loadImage(opts.find);
    const plainness = variance(needle);
    if (plainness < MIN_VARIANCE) {
      throw new Error(
        `'${opts.find}' is too plain to locate (variance ${plainness.toFixed(2)}, needs ${MIN_VARIANCE}): ` +
        `a patch this flat matches many places equally well`);
    }
    const scale = await pointScale(os, hay.width);
    const displays = await listDisplays(os, timeoutMs);
    const origin = frameOrigin(displays, os, opts.display);
    const m = findTemplate(hay, needle, opts.minScore ?? 0.9);
    if (!m) {
      // A frame that never held the other monitor is a different answer from a
      // frame that held it and did not contain this: say which happened.
      const gap = coverageWarning(displays,
        { ...origin, width: Math.round(hay.width / scale), height: Math.round(hay.height / scale) });
      throw new Error(`'${opts.find}' is not on screen (nothing matched above ${opts.minScore ?? 0.9})` +
        (gap ? ` - note that ${gap}` : ""));
    }
    // Two corrections, both invisible on a single Retina-less screen: the frame
    // may be denser than the space clicks live in, and it may not start at 0,0.
    const p = toScreenPoint(m.x + needle.width * fx, m.y + needle.height * fy, scale, origin);
    return {
      ...p,
      how: `${opts.find} at ${m.centerX},${m.centerY} in the frame (score ${m.score.toFixed(3)})`,
    };
  }
  throw new Error("no target: pass coordinates, --window=<name> or --find=<template.png>");
}

/**
 * Captured pixels per input point.
 *
 * On a Retina Mac the screenshot is twice the size of the coordinate space that
 * mouse events use, so a match found in the frame has to be halved before it is
 * clicked. Other platforms capture and click in the same units.
 */
async function pointScale(os: OS, frameWidth: number): Promise<number> {
  if (os !== "macos") return 1;
  const r = await runWithTimeout(["osascript", "-e",
    'tell application "Finder" to get bounds of window of desktop'], 5000);
  const logical = Number(r.stdout.split(",")[2]);
  if (!Number.isFinite(logical) || logical <= 0) return 1;
  const ratio = frameWidth / logical;
  // Only trust a clean integer ratio; anything else means the guess is wrong.
  return Math.abs(ratio - Math.round(ratio)) < 0.01 ? Math.round(ratio) : 1;
}

const xy = (a?: string, b?: string) =>
  a === undefined ? {} : { x: Number(a), y: Number(b) };

async function act(action: string, args: string[], opts: Options = {}): Promise<Result> {
  const os = detectOS();
  const base = { action, os };
  const { force = false, sameUnder = 1 } = opts;
  const timeoutMs = timeoutFor(action, opts.timeoutMs);
  const run = runner(action, timeoutMs);

  // Fail before touching the machine, with the reason and the fix, not an opaque
  // exit code from a missing binary or an absent display.
  if (!["os", "diff"].includes(action)) {
    const pre = preflight(os, action, probe);
    if (!pre.ok) return { ok: false, ...base, error: pre.reason };
  }

  // Nothing typed at a login window ever helps. Only a definite "locked"
  // blocks; an unreadable session state is not treated as one.
  if (INPUT_ACTIONS.includes(action) && !force) {
    const locked = await isSessionLocked({ os, read: () => readLockState(os) });
    if (locked === true) return { ok: false, ...base, error: LOCKED_REASON };
  }

  // The same problem one layer up: the session is unlocked, but a dialog took
  // focus and would receive the keystrokes instead. Opt-in, because cuse cannot
  // know what the caller meant to type at.
  if (opts.expectFront && INPUT_ACTIONS.includes(action) && !force) {
    try {
      const argv = frontmostCmd(os);
      const r = await runWithTimeout(argv, 5000);
      const front = r.code === 0 && !r.timedOut ? parseFrontmost(r.stdout) : "";
      if (!frontmostMatches(front, opts.expectFront)) {
        return { ok: false, ...base,
          error: `'${front}' is in front, not '${opts.expectFront}' - ` +
            `something took focus and would have received this input` };
      }
    } catch { /* cannot tell: do not block on it */ }
  }

  try {
    switch (action) {
      case "os": return { ok: true, ...base, detail: os };

      case "capture": {
        // Absolute, because the Windows backend saves through .NET, whose
        // working directory is not PowerShell's.
        const out = resolve(args[0] ?? "out.png");
        await captureTo(os, out, timeoutMs, run, opts.display);
        const size = (await Bun.file(out).exists()) ? Bun.file(out).size : 0;
        if (size === 0) return { ok: false, ...base, error: "no file produced" };
        // Two ways a frame can be useless: it shows nothing, or it shows only
        // part of the desk. The second is silent on a second monitor, where
        // `screencapture` writes one file per screen and cuse asked for one.
        const warn = [await inspectFrame(out, size),
                      await captureCoverage(os, out, timeoutMs, opts.display)]
          .filter(Boolean).join("; ");
        return { ok: true, ...base, detail: `${size}B -> ${out}`, ...(warn ? { warn } : {}) };
      }

      case "record": {
        // N captures in a row, for state that only misbehaves while it changes.
        const count = Number(args[0] ?? 3);
        const gapMs = Number(args[1] ?? 500);
        const files: string[] = [];
        for (let i = 0; i < count; i++) {
          const out = resolve(`record-${String(i).padStart(3, "0")}.png`);
          await captureTo(os, out, timeoutMs, run);
          files.push(out);
          if (i < count - 1) await Bun.sleep(gapMs);
        }
        return { ok: true, ...base, detail: `${files.length} frames every ${gapMs}ms`, data: files };
      }

      // Wait until the screen stops moving. An agent that acts while a window is
      // still drawing cannot tell its own effect from the animation - which is
      // exactly what broke the input check in CI.
      //
      // One quiet interval is not enough: an app that has been launched but has
      // not drawn yet is perfectly still, and settling there means measuring the
      // window's arrival as if it were your own doing. So require several quiet
      // intervals in a row.
      case "settle": {
        // Bounded twice: by the number of checks and by wall-clock, so a
        // display that captures slower than expected still returns.
        const deadline = Date.now() + (opts.timeoutMs ?? 120_000);
        const tries = Number(args[0] ?? 30);
        const gapMs = Number(args[1] ?? 500);
        const needed = Number(args[2] ?? 3);
        // "Still" cannot mean pixel-identical: a blinking text caret keeps ~39
        // pixels moving forever, and demanding perfection meant settle never
        // returned on a window with a cursor in it. A window still drawing
        // moves thousands, so the two are nowhere near each other.
        const quietUnder = opts.sameUnder ?? 0.1;
        const frames = [resolve("settle-a.png"), resolve("settle-b.png")];
        let cur = 0, streak = 0, last;
        await captureTo(os, frames[cur]!, timeoutMs, run);
        for (let i = 1; i <= tries; i++) {
          if (Date.now() > deadline) {
            return { ok: false, ...base, error: `settle ran out of time after ${i - 1} checks` };
          }
          await Bun.sleep(gapMs);
          const next = 1 - cur;
          await captureTo(os, frames[next]!, timeoutMs, run);
          last = diffImages(await loadImage(frames[cur]!), await loadImage(frames[next]!), 30, quietUnder);
          streak = last.verdict === "SAME" ? streak + 1 : 0;
          cur = next;
          if (streak >= needed) {
            return { ok: true, ...base,
              detail: `settled after ${i} check${i > 1 ? "s" : ""} (${needed} quiet in a row)`,
              data: last };
          }
        }
        return { ok: false, ...base,
          error: `the screen never went quiet: still changing after ${tries} checks`,
          data: last };
      }

      // Two coordinate spaces exist and they are not always the same one: a
      // Retina capture is twice the size of the space clicks live in. Anything
      // that turns a pixel into a click has to know the ratio, so cuse says it
      // rather than leaving every caller to guess.
      case "screen": {
        const shot = resolve("screen-probe.png");
        await captureTo(os, shot, timeoutMs, run, opts.display);
        const img = readHeader(new Uint8Array(await Bun.file(shot).arrayBuffer()));
        if (!img) return { ok: false, ...base, error: "capture produced something that is not a PNG" };
        const scale = await pointScale(os, img.width);
        const displays = await listDisplays(os, timeoutMs);
        const origin = frameOrigin(displays, os, opts.display);
        const frame = {
          ...origin,
          width: Math.round(img.width / scale), height: Math.round(img.height / scale),
        };
        const data = {
          frameWidth: img.width, frameHeight: img.height,
          pointWidth: frame.width, pointHeight: frame.height,
          scale,
          // Where the frame's first pixel is: 0,0 everywhere except a Windows
          // desk with a monitor left of or above the primary one.
          originX: origin.x, originY: origin.y,
          displays,
          desktop: desktopBounds(displays),
        };
        const warn = coverageWarning(displays, frame);
        return { ok: true, ...base,
          detail: `${data.frameWidth}x${data.frameHeight} pixels, ${data.pointWidth}x${data.pointHeight} points ` +
            `(scale ${scale}) at ${origin.x},${origin.y}` +
            (displays.length ? `; ${displays.length} display${displays.length > 1 ? "s" : ""}: ` +
              displays.map((d) => `${d.width}x${d.height}+${d.x}+${d.y}${d.primary ? "*" : ""}`).join(" ")
                              : "; display list unavailable"),
          ...(warn ? { warn } : {}),
          data };
      }

      // The desktop's closest thing to a DOM: role, name and rectangle per
      // control, which is what makes "click the button that says Save" possible.
      case "elements": {
        const els = await listElements(os, args[0] ?? "", timeoutMs);
        const named = els.filter((e) => e.name);
        const blind = blindNote(await isSessionLocked({ os, read: () => readLockState(os) }), els.length === 0);
        return { ok: true, ...base,
          ...(blind ? { warn: blind } : {}),
          detail: `${els.length} controls, ${named.length} named` +
            (named.length ? `: ${named.slice(0, 6).map((e) => `${e.role} '${e.name}'`).join(", ")}` : ""),
          data: els };
      }

      // Wait for a thing, rather than sleeping and hoping. A fixed sleep is
      // either too short on a slow machine or wasted time on a fast one, and
      // this repo's own CI had a hand-rolled version of this loop - which is
      // the usual sign of a missing verb.
      case "wait": {
        const target: WaitTarget = { element: opts.element, role: opts.role, window: opts.window };
        if (!targetIsUsable(target)) {
          return { ok: false, ...base, error: "wait needs --element=<name>, --role=<kind> or --window=<name>" };
        }
        const budget = opts.timeoutMs ?? 30_000;
        const gapMs = Number(args[0] ?? 400);
        const started = Date.now();
        const deadline = started + budget;
        const gone = opts.gone ?? false;
        let looks = 0;
        let sample = "";

        for (;;) {
          looks++;
          let found = false;
          try {
            if (target.element || target.role) {
              const els = await listElements(os, opts.app ?? opts.window ?? "", timeoutMs);
              found = pickElement(els, { name: target.element, role: target.role }) !== null;
              sample = describeMisses(els, { name: target.element, role: target.role }, 5);
            } else {
              const wins = await listWindows(os, timeoutMs);
              found = pickWindow(wins, target.window!) !== null;
              // A dialog can hold the keyboard without being enumerable: on
              // Windows the "Select an app" chooser is frontmost and absent from
              // the window list, so waiting for it never ended. What has focus
              // is part of what is on screen.
              if (!found) {
                const fr = await runWithTimeout(frontmostCmd(os), 5000);
                const front = fr.code === 0 && !fr.timedOut ? parseFrontmost(fr.stdout) : "";
                found = front !== "" && frontmostMatches(front, target.window!);
                sample = [wins.map((w) => w.title).filter(Boolean).slice(0, 4).join(", "),
                          front && `frontmost: ${front}`].filter(Boolean).join(" | ");
              } else {
                sample = wins.map((w) => w.title).filter(Boolean).slice(0, 5).join(", ");
              }
            }
          } catch (e) {
            // A tree that cannot be read yet is a reason to keep waiting, not to
            // give up: the app may not have registered on the bus.
            sample = e instanceof Error ? e.message : String(e);
          }

          const elapsed = Date.now() - started;
          if (isSatisfied(found, gone)) {
            return { ok: true, ...base, detail: successDetail(target, gone, elapsed, looks),
              data: { waitedMs: elapsed, looks } };
          }
          const gap = nextGap(deadline, Date.now(), gapMs);
          if (gap === 0) {
            const blind = blindNote(await isSessionLocked({ os, read: () => readLockState(os) }), !sample);
            return { ok: false, ...base,
              error: timeoutReason(target, gone, elapsed, blind ?? sample),
              data: { waitedMs: elapsed, looks } };
          }
          await Bun.sleep(gap);
        }
      }

      // Who has the keyboard? A system dialog that steals focus is invisible to
      // an agent reading only exit codes.
      case "frontmost": {
        const argv = frontmostCmd(os);
        const r = await runWithTimeout(argv, timeoutMs);
        const problem = explainFailure(argv, r, timeoutMs);
        if (problem) throw new Error(problem);
        const front = parseFrontmost(r.stdout);
        return { ok: true, ...base, detail: front || "(nothing is frontmost)", data: { front } };
      }

      // What is on screen right now, and where. The first half of aiming.
      case "windows": {
        const wins = await listWindows(os, timeoutMs);
        const named = wins.filter((w) => w.title);
        const blind = blindNote(await isSessionLocked({ os, read: () => readLockState(os) }), wins.length === 0);
        // What has the keyboard is not always in the list. A system dialog can be
        // frontmost and unenumerable, and an agent that trusts the list alone
        // will aim past it - so the discrepancy is reported, not hidden.
        const fr = await runWithTimeout(frontmostCmd(os), 5000);
        const front = fr.code === 0 && !fr.timedOut ? parseFrontmost(fr.stdout) : "";
        const hidden = front && !pickWindow(wins, front.split(" ")[0] ?? front) &&
          !wins.some((w) => w.title && frontmostMatches(front, w.title));
        return { ok: true, ...base,
          detail: named.length ? named.map((w) => `${w.title} ${w.width}x${w.height}+${w.x}+${w.y}`).join("; ")
                               : "no titled windows",
          ...(blind ? { warn: blind }
                    : hidden ? { warn: `'${front}' has the keyboard but is not in this list` } : {}),
          data: wins };
      }

      // Where is this picture on the screen? Returns a point to click.
      case "find": {
        const [needlePath, hayPath] = args;
        if (!needlePath) return { ok: false, ...base, error: "find needs a template PNG" };
        // With a second frame, search inside that file instead of the screen.
        // Deterministic, and it makes the matcher answerable offline - the live
        // screen is a moving target, which is a bad thing to test a matcher on.
        if (hayPath) {
          const [hay, needle] = [await loadImage(hayPath), await loadImage(needlePath)];
          const plain = variance(needle);
          if (plain < MIN_VARIANCE) {
            return { ok: false, ...base,
              error: `'${needlePath}' is too plain to locate (variance ${plain.toFixed(2)}, needs ${MIN_VARIANCE})` };
          }
          const m = findTemplate(hay, needle, opts.minScore ?? 0.9);
          if (!m) return { ok: false, ...base, error: `'${needlePath}' is not in '${hayPath}'` };
          return { ok: true, ...base,
            detail: `found at ${m.x},${m.y} centre ${m.centerX},${m.centerY} (score ${m.score.toFixed(3)})`,
            data: { x: m.centerX, y: m.centerY, left: m.x, top: m.y, score: m.score } };
        }
        const t = await resolveTarget(os, { ...opts, find: needlePath }, timeoutMs, run);
        return { ok: true, ...base, detail: `found ${t.how} -> click ${t.x},${t.y}`,
          data: { x: t.x, y: t.y } };
      }

      // Cut a template out of a screenshot, which is how a needle gets made.
      case "crop": {
        const [src, x, y, w, h, out] = args;
        if (!src || !out) return { ok: false, ...base, error: "crop needs <in.png> <x> <y> <w> <h> <out.png>" };
        const full = await loadImage(src);
        // Coordinates are given in the space clicks use; the frame may be
        // denser. Scale them so a crop taken from a window rectangle lands on
        // that window rather than a quarter of the way into the screen.
        const k = await pointScale(os, full.width);
        const img = crop(full, Number(x) * k, Number(y) * k, Number(w) * k, Number(h) * k);
        await Bun.write(resolve(out), encodePNG(img, deflate));
        return { ok: true, ...base, detail: `${img.width}x${img.height} -> ${out}` };
      }

      case "diff": {
        const [a, b] = [args[0], args[1]];
        if (!a || !b) return { ok: false, ...base, error: "diff needs two PNG paths" };
        const d = diffImages(await loadImage(a), await loadImage(b), 30, sameUnder);
        return { ok: true, ...base, detail: `changed ${d.percent}% - ${d.verdict}`, data: d };
      }

      case "type": { await run(typeCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: "typed" }; }
      case "focus": { await run(focusCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: `focused ${args[0]}` }; }
      case "launch": { await run(launchCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: `launched ${args[0]}` }; }
      case "key": { await run(chordToOS(os, args[0] ?? "").cmd); return { ok: true, ...base, detail: `sent ${args[0]}` }; }

      case "move": {
        const t = args[0] !== undefined
          ? { x: Number(args[0]), y: Number(args[1]), how: `${args[0]},${args[1]}` }
          : await resolveTarget(os, opts, timeoutMs, run);
        await execute(movePlan(os, t.x, t.y), run);
        return { ok: true, ...base, detail: `moved to ${t.how}`, data: { x: t.x, y: t.y } };
      }
      case "click": case "dblclick": {
        const count = action === "dblclick" ? 2 : 1;
        // Coordinates if given; otherwise aim at a window or a picture. A bare
        // click with neither still clicks wherever the cursor already is.
        const aimed = opts.window || opts.find || opts.element || opts.role;
        const t = args[0] !== undefined
          ? { x: Number(args[0]), y: Number(args[1]), how: `${args[0]},${args[1]}` }
          : aimed ? await resolveTarget(os, opts, timeoutMs, run) : null;
        await execute(clickPlan(os, count, t?.x, t?.y), run);
        return { ok: true, ...base,
          detail: t ? `${action} at ${t.how}` : action,
          ...(t ? { data: { x: t.x, y: t.y } } : {}) };
      }
      case "scroll": {
        const dir = (args[0] as "up" | "down") ?? "down";
        const amount = Number(args[1] ?? 3);
        await execute(scrollPlan(os, dir, amount), run);
        return { ok: true, ...base, detail: `scrolled ${dir} ${amount}` };
      }

      case "select-all": case "copy": case "paste": {
        await run(chordToOS(os, comboKey(os, action)).cmd);
        return { ok: true, ...base, detail: action };
      }

      default: return { ok: false, ...base, error: `unknown action '${action}'` };
    }
  } catch (e) {
    return { ok: false, ...base, error: e instanceof Error ? e.message : String(e) };
  }
}

export const VERSION = "2.2.0";

/**
 * One process, many commands.
 *
 * An agent doing twenty things paid for twenty process starts and re-enumerated
 * the desktop each time. Here it sends one line per action and reads one JSON
 * Result per line, and the session remembers `--app` and `--window` so they do
 * not have to be repeated. A line that fails is a failed Result, not the end of
 * the loop: an agent recovers from a missing button, and killing its tool over
 * one is not help.
 */
async function serve(initial: Session): Promise<void> {
  let session = { ...initial };
  const emit = (r: unknown) => console.log(JSON.stringify(r));

  for await (const chunk of console) {
    const line = chunk.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "quit" || line === "exit") break;

    const argv = tokenize(line);
    // `use` sets what later lines can leave out.
    if (argv[0] === "use") {
      const { opts } = parseArgs(argv);
      session = {
        app: opts.app ?? session.app,
        window: opts.window ?? session.window,
        timeoutMs: opts.timeoutMs ?? session.timeoutMs,
        force: opts.force || session.force,
      };
      emit({ ok: true, action: "use", os: detectOS(), detail: JSON.stringify(session), data: session });
      continue;
    }

    try {
      const { action, args, opts } = parseArgs(argv);
      emit(await act(action, args, withSession(opts, session)));
    } catch (e) {
      emit({ ok: false, action: argv[0] ?? "", os: detectOS(),
             error: e instanceof Error ? e.message : String(e) });
    }
  }
}

const HELP = `cuse ${VERSION} - cross-platform computer-use CLI

  cuse <action> [args] [flags]

Screen
  capture [out.png]            screenshot; warns when the frame is blank
  record [n] [gapMs]           n captures in a row
  settle [tries] [gapMs] [n]   wait until the screen stops changing
                               (--same-under sets how much noise counts as still)
  diff <a.png> <b.png>         how much changed: SAME or CHANGED

Windows and apps
  launch <app>                 start an app
  focus <name>                 bring a window to the front
  windows                      list visible windows with their rectangles
  frontmost                    which window currently has the keyboard
  wait [gapMs]                 until --element / --window shows up (or --gone)
  elements [app]               controls in the accessibility tree: role, name, rect

Finding things
  find <template.png> [in.png] where that picture is: on screen, or in a frame
  crop <in.png> x y w h <out>  cut a template out of a screenshot

Input
  type <text>                  send text to the focused window
  key <chord>                  e.g. cmd+s, ctrl+shift+a, Return
  move <x> <y>                 move the cursor
  click | dblclick [x] [y]     click; or aim with --window / --find
  scroll <up|down> [amount]    scroll the view under the cursor
  select-all | copy | paste    the platform's own chord for each

Other
  os                           which platform this is
  serve                        read one command per line, answer one JSON per line
  screen                       frame size, point size, the ratio, and every display

Flags
  --json                       structured Result on stdout
  --timeout=<ms>               deadline for this action
  --same-under=<pct>           diff tolerance; 0 means "did anything change"
  --element=<name>             aim at a control by its accessibility name
  --role=<kind>                narrow it: button, text, checkbox, link, ...
  --app=<name>                 which application's controls to look at
  --window=<name>              aim at a window instead of a coordinate
  --find=<template.png>        aim at whatever matches this picture
  --at=<fx,fy>                 where inside the target, 0..1 (default centre)
  --min-score=<0..1>           how close a match must be (default 0.9)
  --display=<n>                which screen to capture, 1-based (macOS)
  --gone                       wait for the target to disappear instead
  --expect-front=<name>        refuse to type unless that window is in front
  --force                      act even if the session looks locked
  --help, --version

Exit codes
  0 ok   1 failed   2 bad usage   3 timed out   4 refused (locked or missing dep)`;

/** Exit codes an agent can branch on without parsing prose. */
export function exitCodeFor(r: Result): number {
  if (r.ok) return 0;
  const e = r.error ?? "";
  if (/^unknown action|needs two PNG paths/.test(e)) return 2;
  if (/did not finish within|ran out of time|never went quiet/.test(e)) return 3;
  if (/not found:|DISPLAY is unset|session is locked|unsupported platform/.test(e)) return 4;
  return 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(HELP);
    process.exit(0);
  }
  if (argv.includes("--version")) {
    console.log(VERSION);
    process.exit(0);
  }
  const { action, args, opts, json: wantJson } = parseArgs(argv);
  if (action === "serve") {
    await serve({ app: opts.app, window: opts.window, timeoutMs: opts.timeoutMs, force: opts.force });
    process.exit(0);
  }
  const r = await act(action, args, opts);
  console.log(wantJson ? JSON.stringify(r) : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cuse: ${r.error}`);
  if (!wantJson && r.warn) console.warn(`cuse: warning: ${r.warn}`);
  process.exit(exitCodeFor(r));
}

export { act };
