#!/usr/bin/env bun
// cuse - cross-platform computer-use CLI. One verb, the right OS primitive.
// Structured Result + --json. Actions delegate to pure builders (tested).

import { resolve } from "node:path";
import { inflateSync, deflateSync } from "node:zlib";
import { detectOS, chordToOS, type OS } from "./os.ts";
import { captureCmd, typeCmd, launchCmd, focusCmd, comboKey } from "./commands.ts";
import { movePlan, clickPlan, scrollPlan, type Plan } from "./plan.ts";
import { preflight, frameWarning, INPUT_ACTIONS, type Probe } from "./preflight.ts";
import { isSessionLocked, LOCK_QUERY, LOCKED_REASON } from "./session.ts";
import { decodePNG, diffImages, isUniform, readHeader, type Image } from "./png.ts";
import { runWithTimeout, runBytes, explainFailure, timeoutFor } from "./exec.ts";
import { encodePNG } from "./png.ts";
import { decodeXWD } from "./xwd.ts";
import { listWindowsCmd, parseWindows, pickWindow, pointIn, frontmostCmd, parseFrontmost,
         frontmostMatches, type Win } from "./window.ts";
import { findTemplate, crop, variance, MIN_VARIANCE } from "./match.ts";

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
                         run: (argv: string[]) => Promise<void>): Promise<void> {
  const plan = captureCmd(os, out);
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
    await captureTo(os, shot, timeoutMs, run);
    const hay = await loadImage(shot);
    const needle = await loadImage(opts.find);
    const plainness = variance(needle);
    if (plainness < MIN_VARIANCE) {
      throw new Error(
        `'${opts.find}' is too plain to locate (variance ${plainness.toFixed(2)}, needs ${MIN_VARIANCE}): ` +
        `a patch this flat matches many places equally well`);
    }
    const m = findTemplate(hay, needle, opts.minScore ?? 0.9);
    if (!m) throw new Error(`'${opts.find}' is not on screen (nothing matched above ${opts.minScore ?? 0.9})`);
    // The frame may be larger than the coordinate space input uses: a Retina
    // capture is twice the point size, so scale the hit back before clicking.
    const scale = await pointScale(os, hay.width);
    return {
      x: Math.round((m.x + needle.width * fx) / scale),
      y: Math.round((m.y + needle.height * fy) / scale),
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
        await captureTo(os, out, timeoutMs, run);
        const size = (await Bun.file(out).exists()) ? Bun.file(out).size : 0;
        if (size === 0) return { ok: false, ...base, error: "no file produced" };
        const warn = await inspectFrame(out, size);
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
        await captureTo(os, shot, timeoutMs, run);
        const img = readHeader(new Uint8Array(await Bun.file(shot).arrayBuffer()));
        if (!img) return { ok: false, ...base, error: "capture produced something that is not a PNG" };
        const scale = await pointScale(os, img.width);
        const data = {
          frameWidth: img.width, frameHeight: img.height,
          pointWidth: Math.round(img.width / scale), pointHeight: Math.round(img.height / scale),
          scale,
        };
        return { ok: true, ...base,
          detail: `${data.frameWidth}x${data.frameHeight} pixels, ${data.pointWidth}x${data.pointHeight} points (scale ${scale})`,
          data };
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
        return { ok: true, ...base,
          detail: named.length ? named.map((w) => `${w.title} ${w.width}x${w.height}+${w.x}+${w.y}`).join("; ")
                               : "no titled windows",
          data: wins };
      }

      // Where is this picture on the screen? Returns a point to click.
      case "find": {
        const needlePath = args[0];
        if (!needlePath) return { ok: false, ...base, error: "find needs a template PNG" };
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
        const aimed = opts.window || opts.find;
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

export const VERSION = "2.1.0";

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

Finding things
  find <template.png>          where that picture is; prints a point to click
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
  screen                       frame size, point size, and the ratio between

Flags
  --json                       structured Result on stdout
  --timeout=<ms>               deadline for this action
  --same-under=<pct>           diff tolerance; 0 means "did anything change"
  --window=<name>              aim at a window instead of a coordinate
  --find=<template.png>        aim at whatever matches this picture
  --at=<fx,fy>                 where inside the target, 0..1 (default centre)
  --min-score=<0..1>           how close a match must be (default 0.9)
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
  const json = argv.includes("--json");
  const force = argv.includes("--force");
  if (argv.includes("--help") || argv.includes("-h") || argv.length === 0) {
    console.log(HELP);
    process.exit(0);
  }
  if (argv.includes("--version")) {
    console.log(VERSION);
    process.exit(0);
  }
  const flag = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
  const sameUnder = flag("same-under") !== undefined ? Number(flag("same-under")) : 1;
  const timeoutMs = flag("timeout") !== undefined ? Number(flag("timeout")) : undefined;
  const window = flag("window");
  const find = flag("find");
  const minScore = flag("min-score") !== undefined ? Number(flag("min-score")) : undefined;
  const expectFront = flag("expect-front");
  const atRaw = flag("at");
  const at = atRaw ? atRaw.split(",").map(Number) as [number, number] : undefined;
  const [action, ...args] = argv.filter((a) => !a.startsWith("--"));
  const r = await act(action ?? "", args, { force, sameUnder, timeoutMs, window, find, at, minScore, expectFront });
  console.log(json ? JSON.stringify(r) : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cuse: ${r.error}`);
  if (!json && r.warn) console.warn(`cuse: warning: ${r.warn}`);
  process.exit(exitCodeFor(r));
}

export { act };
