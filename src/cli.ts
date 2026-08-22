#!/usr/bin/env bun
// cuse - cross-platform computer-use CLI. One verb, the right OS primitive.
// Structured Result + --json. Actions delegate to pure builders (tested).

import { resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inflateSync, deflateSync } from "node:zlib";
import { detectOS, chordToOS, normalizeMods, type OS } from "./os.ts";
import { captureCmd, typeCmd, launchCmd, focusCmd, comboKey, videoCmd } from "./commands.ts";
import { movePlan, clickPlan, dragPlan, scrollPlan, type MouseButton, type Plan } from "./plan.ts";
import { preflight, frameWarning, INPUT_ACTIONS, type Probe } from "./preflight.ts";
import { isSessionLocked, blindNote, LOCK_QUERY, LOCKED_REASON } from "./session.ts";
import { decodePNG, diffImages, isUniform, readHeader, type Image } from "./png.ts";
import { runWithTimeout, runBytes, explainFailure, timeoutFor } from "./exec.ts";
import { encodePNG } from "./png.ts";
import { decodeXWD } from "./xwd.ts";
import { listWindowsCmd, parseWindows, pickWindow, pointIn, frontmostCmd, parseFrontmost,
         frontmostMatches, windowCropRect, type Win } from "./window.ts";
import { findTemplate, crop, variance, MIN_VARIANCE } from "./match.ts";
import { elementsCmd, parseElements, pickElement, pointInElement, describeElement, describeMisses,
         geometryLooksUsable, normalizeRole, type Element } from "./elements.ts";
import { runningAppsCmd, parseApps, pickApp, describeApps, type App } from "./apps.ts";
import { displaysCmd, parseDisplays, frameOrigin, coverageWarning, toScreenPoint,
         desktopBounds, type Display } from "./display.ts";
import { parseArgs, tokenize, withSession, type Session } from "./args.ts";
import { recognizeText } from "./ocr.ts";
import { parseScenario, runScenario, type ScenarioValue } from "./scenario.ts";
import { runComparison, type ComparisonManifest } from "./compare-run.ts";
import { describeTarget, targetIsUsable, isSatisfied, nextGap, timeoutReason,
         successDetail, type WaitTarget } from "./wait.ts";
import { probeProcess } from "./probes/process.ts";
import { probePort } from "./probes/port.ts";
import { probeFile } from "./probes/file.ts";
import { probeScheduledTask } from "./probes/scheduled-task.ts";
import { probeService } from "./probes/service.ts";
import type { PortProtocol } from "./probes/types.ts";
import { realDoctorProbe, runDoctor, type DoctorVerdict } from "./doctor.ts";

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
  /** which named object (e.g. scheduled task) to inspect */
  name?: string;
  /** mouse button used by click and dblclick */
  button?: string;
  /** modifier chord held during click and dblclick */
  modifiers?: string;
  /** wait for the target to disappear rather than to appear */
  gone?: boolean;
  /** which screen to capture, 1-based, where the platform can pick one */
  display?: number;
  /** how deep to walk an accessibility tree, and how many controls to keep */
  depth?: number;
  limit?: number;
  /** record actual video rather than a series of stills */
  video?: boolean;
  /** where to write it */
  out?: string;
  pid?: number;
  port?: number;
  protocol?: string;
  durationMs?: number;
  steps?: number;
};

export type Result = {
  ok: boolean; action: string; os: OS;
  detail?: string; error?: string; warn?: string; data?: unknown;
};

function isScenarioValue(value: unknown): value is ScenarioValue {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
      typeof value === "string") return true;
  if (Array.isArray(value)) return value.every(isScenarioValue);
  if (typeof value !== "object") return false;
  return Object.values(value).every(isScenarioValue);
}

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
      if (plan.op === "click") return mac.click(plan.count, plan.x, plan.y, plan.button, plan.mods);
      if (plan.op === "drag") {
        return mac.drag(plan.fromX, plan.fromY, plan.toX, plan.toY, plan.durationMs, plan.steps);
      }
      return mac.scroll(plan.lines, plan.axis);
    }
  }
}

/** Focus an aimed field, replace its contents, and type the requested value. */
export async function fillTarget(os: OS, text: string, x: number, y: number,
                                 run: (argv: string[]) => Promise<void>,
                                 perform: typeof execute = execute): Promise<void> {
  await perform(clickPlan(os, 1, x, y), run);
  await run(chordToOS(os, comboKey(os, "select-all")).cmd);
  await run(typeCmd(os, text));
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

type SessionFrameProbe = {
  capture: typeof captureTo;
  inspect: typeof inspectFrame;
  size: (path: string) => Promise<number>;
  remove: (path: string) => Promise<void>;
  tempPath: () => string;
};

const realSessionFrameProbe: SessionFrameProbe = {
  capture: captureTo,
  inspect: inspectFrame,
  size: async (path) => (await Bun.file(path).exists()) ? Bun.file(path).size : 0,
  remove: async (path) => { await rm(path, { force: true }); },
  tempPath: () => resolve(tmpdir(), `cuse-session-${process.pid}-${crypto.randomUUID()}.png`),
};

/** Confirm the blank frame that macOS returns when this process has no usable window server. */
export async function macSessionUnreachable(timeoutMs: number,
                                            sessionProbe: SessionFrameProbe = realSessionFrameProbe): Promise<string | undefined> {
  const out = sessionProbe.tempPath();
  const budget = Math.min(timeoutMs, 3000);
  try {
    await sessionProbe.capture("macos", out, budget, runner("capture", budget));
    const bytes = await sessionProbe.size(out);
    if (bytes === 0) return undefined;
    return await sessionProbe.inspect(out, bytes);
  } catch {
    // An unreadable probe is unknown, not a refusal. Let the command report its own error.
    return undefined;
  } finally {
    await sessionProbe.remove(out).catch(() => {});
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

/**
 * Ask the platform's accessibility tree for an application's controls.
 *
 * `note` is how a slower or less capable route says so. Falling back silently
 * is what would turn "this machine does not trust cuse" into "Finder has no
 * controls", which is the shape of every bug in this repo's history.
 */
type Tree = { els: Element[]; note?: string };

async function listElements(os: OS, app: string, timeoutMs: number,
                            depth?: number, limit?: number): Promise<Tree> {
  if (os === "macos") return macElements(app, timeoutMs, depth, limit);
  const argv = elementsCmd(os, app, limit, depth);
  const r = await runWithTimeout(argv, timeoutMs);
  const problem = explainFailure(argv, r, timeoutMs);
  if (problem) throw new Error(problem);
  return { els: parseElements(r.stdout, os) };
}

/**
 * The macOS tree, read through the C API rather than System Events.
 *
 * Every attribute asked for through AppleScript is a message to another
 * process: Finder took longer than the deadline and came back as a timeout, so
 * the most ordinary app on the machine had no readable tree at all. The same
 * data through the accessibility API takes about a third of a second.
 *
 * Loaded lazily, like the mouse code, so that importing the CLI on Linux or
 * Windows never touches bun:ffi or a framework that is not there.
 */
async function macElements(app: string, timeoutMs: number,
                           depth?: number, limit?: number): Promise<Tree> {
  const ax = await import("./macax.ts");
  // Trust is per process, and cuse's is not System Events'. A machine can have
  // AppleScript reading trees perfectly while this binary is refused, so the
  // slow route stays reachable rather than turning that into "no controls".
  if (!ax.trusted()) return systemEventsElements(app, timeoutMs);

  const argv = runningAppsCmd();
  const r = await runWithTimeout(argv, Math.min(timeoutMs, 10_000));
  const problem = explainFailure(argv, r, timeoutMs);
  if (problem) throw new Error(problem);
  const apps = parseApps(r.stdout);

  // No name means whatever is in front, which is what the AppleScript version
  // fell back to and what an agent driving one window expects.
  const target = app ? pickApp(apps, app) : await frontmostApp(apps);
  if (!target) {
    throw new Error(`no running application matching '${app}' - what is running: ${describeApps(apps)}`);
  }
  const walk = ax.elementsOfPid(target.pid, limit ?? 300, depth ?? 12, Date.now() + timeoutMs);
  // A tree that stopped early is missing controls, and a caller who cannot tell
  // that apart from an app without them will conclude the wrong thing.
  const truncated = walk.stopped === "deadline"
    ? `the walk ran out of time after ${walk.rows.length} controls - there is more of this tree ` +
      `than was read (raise --timeout, or narrow it with --depth)`
    : walk.stopped === "limit"
    ? `stopped at the --limit of ${limit ?? 300} controls - this tree is bigger than that`
    : undefined;
  return { note: truncated, els: walk.rows.map((e) => ({
    rawRole: e.role,
    role: normalizeRole(e.role, "macos"),
    name: e.name,
    x: Math.round(e.x), y: Math.round(e.y),
    width: Math.round(e.width), height: Math.round(e.height),
    value: e.value,
    enabled: e.enabled,
    focused: e.focused,
    selected: e.selected,
    expanded: e.expanded,
    automationId: e.automationId,
    checked: e.checked,
    processId: target.pid,
  })) };
}

/** The fallback route, through System Events, for an untrusted process. */
async function systemEventsElements(app: string, timeoutMs: number): Promise<Tree> {
  const unreachable = await macSessionUnreachable(timeoutMs);
  if (unreachable) throw new Error(`no window server session: ${unreachable}`);
  const argv = elementsCmd("macos", app);
  const r = await runWithTimeout(argv, timeoutMs);
  const problem = explainFailure(argv, r, timeoutMs);
  if (problem) throw new Error(`${problem} (and ${UNTRUSTED_SHORT})`);
  return { els: parseElements(r.stdout, "macos"), note: UNTRUSTED_SHORT };
}

const UNTRUSTED_SHORT =
  "cuse itself is not trusted for accessibility, so this went the slow way through " +
  "System Events - grant Accessibility to the terminal running cuse to read trees directly";

/** The app in front, matched back to a pid. */
async function frontmostApp(apps: App[]) {
  const r = await runWithTimeout(frontmostCmd("macos"), 5000);
  const front = r.code === 0 && !r.timedOut ? parseFrontmost(r.stdout).split(" ")[0] : "";
  return front ? pickApp(apps, front) : null;
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
    const { els } = await listElements(os, opts.app ?? opts.window ?? "", timeoutMs,
                                       opts.depth, opts.limit);
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
export async function pointScale(
  os: OS,
  frameWidth: number,
  runner: typeof runWithTimeout = runWithTimeout,
): Promise<number> {
  if (os !== "macos") return 1;

  // Ask the window server, not Finder. The old path asked Finder for the bounds
  // of the desktop window, which reads as the obvious question but routes
  // through an application that can be busy, hidden, or not answering Apple
  // events at all. Measured on a healthy M4: that AppleScript did not return
  // within two minutes, so every `cuse screen` spent the full 5000 ms timeout
  // and then fell back to scale 1. The command still answered correctly, which
  // is why nobody noticed a metadata call costing five seconds.
  //
  // NSScreen.backingScaleFactor is the same number the compositor uses, needs no
  // application to be running, and measured 71 ms.
  const r = await runner(["osascript", "-l", "JavaScript", "-e",
    'ObjC.import("AppKit");' +
    "String($.NSScreen.screens.objectAtIndex(0).backingScaleFactor)"], 5000);
  const scale = Number(r.stdout.trim());
  const roundedScale = Number.isFinite(scale) && scale > 0 ? Math.round(scale) : undefined;
  if (roundedScale !== undefined && roundedScale !== 1) return roundedScale;

  // A disconnected window server can silently report 1 for a Retina display.
  // Cross-check that ambiguous answer against the pixel-to-point ratio.
  const f = await runner(["osascript", "-l", "JavaScript", "-e",
    'ObjC.import("AppKit");' +
    "String($.NSScreen.screens.objectAtIndex(0).frame.size.width)"], 5000);
  const logical = Number(f.stdout.trim());
  if (!Number.isFinite(logical) || logical <= 0) return roundedScale ?? 1;
  const ratio = frameWidth / logical;
  // Only trust a clean integer ratio; anything else means the guess is wrong.
  return Math.abs(ratio - Math.round(ratio)) < 0.01 ? Math.round(ratio) : roundedScale ?? 1;
}

const xy = (a?: string, b?: string) =>
  a === undefined ? {} : { x: Number(a), y: Number(b) };

/** How long to wait before the next settle check.
 *
 *  A fixed gap pays its full cost on a screen that was already quiet: three
 *  checks at 500 ms measured 2452 ms, of which 1500 ms was sleeping. Starting
 *  short and doubling only while frames keep coming back CHANGED answers a
 *  quiet screen in about 968 ms and still gives a repainting app the same
 *  ceiling it had before.
 *
 *  Pure so it can be tested without a screen. */
export function nextGap(current: number, quiet: boolean, min: number, max: number): number {
  if (quiet) return min;
  return Math.min(max, current * 2);
}

export type Step = { name: string; args: string[] };

/** Turn a decoded JSON array into steps, or say why it is not one.
 *
 *  Split out from the run handler so it can be tested the way the rest of this
 *  repo is tested: without launching the CLI or touching a screen. Both shapes
 *  are accepted because models emit both: OpenAI's computer tool returns
 *  objects, and a hand-written batch is easier to read as arrays. */
export function parseSteps(steps: unknown[]): { steps: Step[] } | { error: string } {
  const out: Step[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    let name: string;
    let args: string[];
    if (Array.isArray(step)) {
      name = String(step[0] ?? "");
      args = step.slice(1).map(String);
    } else if (step && typeof step === "object") {
      const o = step as Record<string, unknown>;
      name = String(o.action ?? "");
      args = Array.isArray(o.args) ? o.args.map(String) : [];
    } else {
      return { error: `step ${i + 1} must be an array or an object, got ${typeof step}` };
    }
    if (!name) return { error: `step ${i + 1} has no action name` };
    // Nesting would make "how many completed" ambiguous, and buys nothing: a
    // flat list already expresses any sequence.
    if (name === "run") return { error: "run cannot nest" };
    out.push({ name, args });
  }
  return { steps: out };
}

async function act(action: string, args: string[], opts: Options = {}): Promise<Result> {
  const os = detectOS();
  const base = { action, os };
  if (action === "fill") {
    const aimed = opts.window || opts.find || opts.element || opts.role;
    const hasOneCoordinate = (args[1] !== undefined) !== (args[2] !== undefined);
    if (hasOneCoordinate) {
      return { ok: false, ...base, error: "fill coordinates need both <x> and <y>" };
    }
    const hasCoordinates = args[1] !== undefined && args[2] !== undefined;
    if (!aimed && !hasCoordinates) {
      return { ok: false, ...base,
        error: "fill needs --element=<name>, --role=<kind>, --window=<name>, --find=<template.png>, or coordinates" };
    }
  }
  if (["click", "dblclick"].includes(action) && opts.button &&
      !["left", "right", "middle"].includes(opts.button)) {
    return { ok: false, ...base,
      error: `invalid --button='${opts.button}': expected left, right, or middle` };
  }
  const modifierTokens = opts.modifiers?.split("+") ?? [];
  const invalidModifier = modifierTokens.find((mod) =>
    !["ctrl", "shift", "alt", "opt", "cmd", "meta"].includes(mod.toLowerCase()));
  if (["click", "dblclick"].includes(action) && invalidModifier !== undefined) {
    return { ok: false, ...base,
      error: `invalid --modifiers='${opts.modifiers}': unknown modifier '${invalidModifier}'` };
  }
  if (action === "scroll" && args[0] !== undefined &&
      !["up", "down", "left", "right"].includes(args[0])) {
    return { ok: false, ...base,
      error: `invalid scroll direction '${args[0]}': expected up, down, left, or right` };
  }
  const { force = false, sameUnder = 1 } = opts;
  const timeoutMs = timeoutFor(action, opts.timeoutMs);
  const run = runner(action, timeoutMs);

  // Fail before touching the machine, with the reason and the fix, not an opaque
  // exit code from a missing binary or an absent display.
  if (!["os", "doctor", "diff", "ocr-read", "scenario", "compare", "inspect"].includes(action)) {
    const pre = preflight(os, action === "fill" ? "click" : action, probe);
    if (!pre.ok) return { ok: false, ...base, error: pre.reason };
  }

  // Nothing typed at a login window ever helps. Only a definite "locked"
  // blocks; an unreadable session state is not treated as one.
  if ((INPUT_ACTIONS.includes(action) || action === "fill") && !force) {
    const locked = await isSessionLocked({ os, read: () => readLockState(os) });
    if (locked === true) return { ok: false, ...base, error: LOCKED_REASON };
  }

  // The same problem one layer up: the session is unlocked, but a dialog took
  // focus and would receive the keystrokes instead. Opt-in, because cuse cannot
  // know what the caller meant to type at.
  if (opts.expectFront && (INPUT_ACTIONS.includes(action) || action === "fill") && !force) {
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
      // One process, several actions, in order. A model that decides to click
      // four times already emits those four actions in a single response, and
      // splitting them into four invocations throws the batching away in the
      // last hop: measured here, four separate `cuse move` calls cost 129 ms of
      // which about 108 ms is process startup paid four times.
      //
      // The sequence stops at the first failure and reports what ran, because
      // an agent that clicked twice and then missed needs to know which two
      // landed. Nothing is validated ahead of time beyond the shape: an action
      // that fails on this platform should fail with its own error, not a
      // different one invented by the batcher.
      case "run": {
        const raw = args.join(" ").trim();
        if (!raw) return { ok: false, ...base, error: "run needs a JSON array of actions, or --file" };

        let steps: unknown;
        try { steps = JSON.parse(raw); }
        catch { return { ok: false, ...base, error: "run needs valid JSON: a list of [action, ...args] or {action, args}" }; }
        if (!Array.isArray(steps)) return { ok: false, ...base, error: "run needs a JSON array" };
        if (!steps.length) return { ok: false, ...base, error: "run needs at least one action" };

        const parsed = parseSteps(steps);
        if ("error" in parsed) return { ok: false, ...base, error: parsed.error };

        const ran: Result[] = [];
        for (const { name, args: stepArgs } of parsed.steps) {
          const r = await act(name, stepArgs, opts);
          ran.push(r);
          if (!r.ok) {
            return { ok: false, ...base,
              error: `step ${ran.length} (${name}) failed: ${r.error ?? "unknown"}`,
              detail: `${ran.length - 1} of ${steps.length} completed`,
              data: { ran, completed: ran.length - 1, total: steps.length } };
          }
        }
        return { ok: true, ...base,
          detail: `${ran.length} action${ran.length > 1 ? "s" : ""} in one process`,
          data: { ran, completed: ran.length, total: steps.length } };
      }

      case "scenario": {
        const path = args[0];
        if (!path) {
          return { ok: false, ...base, error: "scenario needs a path to a scenario file" };
        }

        let contents: string;
        try {
          contents = await Bun.file(resolve(path)).text();
        } catch {
          return { ok: false, ...base, error: `scenario file not found: ${path}` };
        }

        let input: unknown;
        try {
          input = JSON.parse(contents);
        } catch {
          return { ok: false, ...base, error: "scenario file must contain valid JSON" };
        }

        const parsed = parseScenario(input);
        if (!parsed.ok) {
          return { ok: false, ...base,
            error: `invalid scenario at ${parsed.error.path}: ${parsed.error.message}` };
        }

        const result = await runScenario(parsed.scenario, {
          invokeCuse: async (action, args, options) => {
            const invoked = await act(action, args, options as Options);
            return {
              ok: invoked.ok,
              error: invoked.error,
              detail: invoked.detail,
              ...(isScenarioValue(invoked.data) ? { data: invoked.data } : {}),
            };
          },
        });
        const ok = result.status === "passed";
        const failedStep = result.steps.find((step) => step.status !== "passed");
        const error = failedStep
          ? `scenario ${result.status}: ${failedStep.phase} step ${failedStep.index + 1}: ` +
            (failedStep.message ?? failedStep.status)
          : `scenario ${result.status}`;
        return {
          ok,
          ...base,
          detail: `scenario ${result.name}: ${result.status} in ${result.durationMs}ms`,
          data: result,
          ...(ok ? {} : { error }),
        };
      }

      case "compare": {
        const path = args[0];
        if (!path) {
          return { ok: false, ...base, error: "compare needs a path to a comparison manifest" };
        }

        let contents: string;
        try {
          contents = await Bun.file(resolve(path)).text();
        } catch {
          return { ok: false, ...base, error: `comparison manifest not found: ${path}` };
        }

        let input: unknown;
        try {
          input = JSON.parse(contents);
        } catch {
          return { ok: false, ...base, error: "comparison manifest must contain valid JSON" };
        }
        if (typeof input !== "object" || input === null || Array.isArray(input)) {
          return { ok: false, ...base, error: "comparison manifest must be an object" };
        }
        const manifestInput = input as Record<string, unknown>;
        const validSetup = (value: unknown): boolean => {
          if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
          const setup = value as Record<string, unknown>;
          return Array.isArray(setup.argv) && setup.argv.every((arg) => typeof arg === "string") &&
            typeof setup.cwd === "string";
        };
        if (typeof manifestInput.scenario !== "string") {
          return { ok: false, ...base, error: "comparison manifest scenario must be a string" };
        }
        if (!validSetup(manifestInput.baseline)) {
          return { ok: false, ...base, error: "comparison manifest baseline needs string argv and cwd" };
        }
        if (!validSetup(manifestInput.candidate)) {
          return { ok: false, ...base, error: "comparison manifest candidate needs string argv and cwd" };
        }
        if (manifestInput.fields !== undefined &&
            (!Array.isArray(manifestInput.fields) ||
             !manifestInput.fields.every((field) => typeof field === "string"))) {
          return { ok: false, ...base, error: "comparison manifest fields must be an array of strings" };
        }
        const manifest = manifestInput as ComparisonManifest;

        let scenarioContents: string;
        try {
          scenarioContents = await Bun.file(resolve(manifest.scenario)).text();
        } catch {
          return { ok: false, ...base, error: `scenario file not found: ${manifest.scenario}` };
        }

        let scenarioInput: unknown;
        try {
          scenarioInput = JSON.parse(scenarioContents);
        } catch {
          return { ok: false, ...base, error: "scenario file must contain valid JSON" };
        }
        const parsed = parseScenario(scenarioInput);
        if (!parsed.ok) {
          return { ok: false, ...base,
            error: `invalid scenario at ${parsed.error.path}: ${parsed.error.message}` };
        }

        const runSide = async () => runScenario(parsed.scenario, {
          invokeCuse: async (action, args, options) => {
            const invoked = await act(action, args, options as Options);
            return {
              ok: invoked.ok,
              error: invoked.error,
              detail: invoked.detail,
              ...(isScenarioValue(invoked.data) ? { data: invoked.data } : {}),
            };
          },
        });
        const { report } = await runComparison(manifest, {
          baseline: runSide,
          candidate: runSide,
        });
        const ok = report.verdict.kind !== "baseline_or_candidate_setup_failed" &&
          report.verdict.kind !== "inconclusive_missing_evidence";
        return { ok, ...base, detail: report.headline, data: report };
      }

      case "os": return { ok: true, ...base, detail: os };

      case "doctor": {
        const report = await runDoctor(os, realDoctorProbe);
        const detail = [
          `verdict: ${report.verdict}`,
          ...report.checks.map((check) => `${check.name}: ${check.status} - ${check.detail}`),
        ].join("\n");
        return {
          ok: report.verdict === "healthy",
          ...base,
          detail,
          ...(report.verdict === "unusable" ? { error: "doctor found unusable capabilities" } : {}),
          data: report,
        };
      }

      case "capture": {
        // Absolute, because the Windows backend saves through .NET, whose
        // working directory is not PowerShell's.
        const out = resolve(args[0] ?? "out.png");
        if (opts.window) {
          const tempDir = await mkdtemp(resolve(tmpdir(), "cuse-capture-"));
          const fullPath = resolve(tempDir, "full.png");
          try {
            await captureTo(os, fullPath, timeoutMs, run, opts.display);
            const wins = await listWindows(os, timeoutMs);
            const win = pickWindow(wins, opts.window);
            if (!win) {
              const seen = wins.map((v) => v.title).filter(Boolean).slice(0, 8).join(", ") || "none";
              return { ok: false, ...base,
                error: `no window matching '${opts.window}' (visible windows: ${seen})` };
            }
            const full = await loadImage(fullPath);
            const rect = windowCropRect(win, await pointScale(os, full.width));
            const img = crop(full, rect.x, rect.y, rect.width, rect.height);
            await Bun.write(out, encodePNG(img, deflate));
          } finally {
            await rm(tempDir, { recursive: true, force: true });
          }
        } else {
          await captureTo(os, out, timeoutMs, run, opts.display);
        }
        const size = (await Bun.file(out).exists()) ? Bun.file(out).size : 0;
        if (size === 0) return { ok: false, ...base, error: "no file produced" };
        // Two ways a frame can be useless: it shows nothing, or it shows only
        // part of the desk. The second is silent on a second monitor, where
        // `screencapture` writes one file per screen and cuse asked for one.
        const warn = [await inspectFrame(out, size),
                      ...(opts.window ? [] : [await captureCoverage(os, out, timeoutMs, opts.display)])]
          .filter(Boolean).join("; ");
        return { ok: true, ...base, detail: `${size}B -> ${out}`, ...(warn ? { warn } : {}) };
      }

      case "record": {
        // Actual video, where the OS has a recorder. Stills cannot show a
        // state that exists only between two of them.
        if (opts.video) {
          const seconds = Number(args[0] ?? 5);
          if (!Number.isFinite(seconds) || seconds <= 0) {
            return { ok: false, ...base, error: "record --video needs a length in seconds" };
          }
          const gap = preflight(os, "video", probe);
          if (!gap.ok) return { ok: false, ...base, error: gap.reason };
          const out = resolve(opts.out ?? (os === "macos" ? "record.mov" : "record.mp4"));
          const argv = videoCmd(os, out, seconds);
          // The deadline has to outlast the recording, or cuse kills its own
          // camera: a 30s clip under a 15s timeout is a file that never closes.
          await runner(action, Math.max(timeoutMs, seconds * 1000 + 15_000))(argv);
          const size = (await Bun.file(out).exists()) ? Bun.file(out).size : 0;
          if (size === 0) return { ok: false, ...base, error: `${argv[0]} produced no file` };
          return { ok: true, ...base, detail: `${seconds}s of video, ${size}B -> ${out}`,
                   data: { path: out, bytes: size, seconds } };
        }
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
        // The gap is a ceiling now, not a fixed wait. A settle on an already
        // quiet screen used to pay 500 ms before every check, three times over,
        // and measured 2452 ms doing nothing: 1500 ms of that was sleeping.
        // Starting at 60 ms and backing off toward the ceiling answers a quiet
        // screen in 978 ms while still giving a repainting app the same room it
        // had before, because the wait only grows once a frame comes back
        // CHANGED. An explicit gap argument keeps its old meaning as a fixed
        // wait, so existing callers are untouched.
        const gapMs = Number(args[1] ?? 500);
        const adaptive = args[1] === undefined;
        const MIN_GAP = 60;
        const needed = Number(args[2] ?? 3);
        // "Still" cannot mean pixel-identical: a blinking text caret keeps ~39
        // pixels moving forever, and demanding perfection meant settle never
        // returned on a window with a cursor in it. A window still drawing
        // moves thousands, so the two are nowhere near each other.
        const quietUnder = opts.sameUnder ?? 0.1;
        const frames = [resolve("settle-a.png"), resolve("settle-b.png")];
        let cur = 0, streak = 0, last;
        let wait = adaptive ? MIN_GAP : gapMs;
        await captureTo(os, frames[cur]!, timeoutMs, run);
        for (let i = 1; i <= tries; i++) {
          if (Date.now() > deadline) {
            return { ok: false, ...base, error: `settle ran out of time after ${i - 1} checks` };
          }
          await Bun.sleep(wait);
          const next = 1 - cur;
          await captureTo(os, frames[next]!, timeoutMs, run);
          last = diffImages(await loadImage(frames[cur]!), await loadImage(frames[next]!), 30, quietUnder);
          streak = last.verdict === "SAME" ? streak + 1 : 0;
          // Back off only when the screen is still moving. A CHANGED frame means
          // something is drawing and checking sooner just burns a capture; a
          // SAME frame means the short wait was enough and there is no reason to
          // slow down.
          if (adaptive) wait = nextGap(wait, last.verdict === "SAME", MIN_GAP, gapMs);
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
      case "element": {
        if (!opts.element && !opts.role) {
          return { ok: false, ...base, error: "element needs --element=<name> or --role=<kind>" };
        }
        const { els } = await listElements(os, args[0] ?? "", timeoutMs,
                                           opts.depth, opts.limit);
        const sel = { name: opts.element, role: opts.role };
        const hit = pickElement(els, sel);
        if (!hit) {
          return { ok: false, ...base,
            error: `no control matching ${opts.element ? `'${opts.element}'` : ""}` +
              `${opts.role ? ` of role '${opts.role}'` : ""} - ` +
              `what is there: ${describeMisses(els, sel)}` };
        }
        return { ok: true, ...base, detail: describeElement(hit), data: hit };
      }

      case "elements": {
        const { els, note } = await listElements(os, args[0] ?? "", timeoutMs,
                                                 opts.depth, opts.limit);
        const named = els.filter((e) => e.name);
        const blind = blindNote(await isSessionLocked({ os, read: () => readLockState(os) }), els.length === 0);
        const said = [blind, note].filter(Boolean).join("; ");
        return { ok: true, ...base,
          ...(said ? { warn: said } : {}),
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
        const beforeDeadline = async <T>(probe: Promise<T>): Promise<T> => {
          const left = Math.max(0, deadline - Date.now());
          if (left === 0) throw new Error("the wait deadline expired during the platform query");
          return Promise.race([
            probe,
            Bun.sleep(left).then(() => { throw new Error("the wait deadline expired during the platform query"); }),
          ]);
        };

        for (;;) {
          looks++;
          let found = false;
          try {
            if (target.element || target.role) {
              const { els } = await beforeDeadline(
                listElements(os, opts.app ?? opts.window ?? "", timeoutMs, opts.depth, opts.limit));
              found = pickElement(els, { name: target.element, role: target.role }) !== null;
              sample = describeMisses(els, { name: target.element, role: target.role }, 5);
            } else {
              const wins = await beforeDeadline(listWindows(os, timeoutMs));
              found = pickWindow(wins, target.window!) !== null;
              // A dialog can hold the keyboard without being enumerable: on
              // Windows the "Select an app" chooser is frontmost and absent from
              // the window list, so waiting for it never ended. What has focus
              // is part of what is on screen.
              if (!found) {
                const fr = await beforeDeadline(runWithTimeout(frontmostCmd(os), 5000));
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
            const blind = sample ? undefined
              : blindNote(await isSessionLocked({ os, read: () => readLockState(os) }), true);
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
        if (os === "macos") {
          const unreachable = await macSessionUnreachable(timeoutMs);
          if (unreachable) return { ok: false, ...base, error: `no window server session: ${unreachable}` };
        }
        const argv = frontmostCmd(os);
        const r = await runWithTimeout(argv, timeoutMs);
        const problem = explainFailure(argv, r, timeoutMs);
        if (problem) throw new Error(problem);
        const front = parseFrontmost(r.stdout);
        return { ok: true, ...base, detail: front || "(nothing is frontmost)", data: { front } };
      }

      // What is on screen right now, and where. The first half of aiming.
      case "windows": {
        if (os === "macos") {
          const unreachable = await macSessionUnreachable(timeoutMs);
          if (unreachable) return { ok: false, ...base, error: `no window server session: ${unreachable}` };
        }
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

      case "ocr-read": {
        const path = args[0];
        if (!path) return { ok: false, ...base, error: "ocr-read needs an image path" };
        const result = await recognizeText(os, path, timeoutMs);
        return { ok: true, ...base,
          detail: result.lines.length ? `${result.lines.length} line(s) recognized` : "no text found",
          data: result };
      }

      case "inspect": {
        const noun = args[0];
        if (!noun) {
          return { ok: false, ...base, error: "inspect needs a noun: process, port, file, service, or scheduled-task" };
        }
        if (noun === "process") {
          if (!Number.isSafeInteger(opts.pid) || opts.pid === undefined || opts.pid <= 0) {
            return { ok: false, ...base, error: "inspect process needs --pid=<n>" };
          }
          const result = await probeProcess(opts.pid, os);
          return { ok: true, ...base,
            detail: result.found
              ? `process ${result.normalized?.pid} found`
              : `process not found or unavailable (${result.status})`,
            data: result };
        }
        if (noun === "port") {
          if (!Number.isSafeInteger(opts.port) || opts.port === undefined || opts.port < 0 || opts.port > 65_535) {
            return { ok: false, ...base, error: "inspect port needs --port=<n>" };
          }
          const protocol = opts.protocol ?? "tcp";
          if (protocol !== "tcp" && protocol !== "udp") {
            return { ok: false, ...base,
              error: `invalid --protocol='${protocol}': expected tcp or udp` };
          }
          const result = await probePort(opts.port, protocol as PortProtocol, os);
          return { ok: true, ...base,
            detail: result.found
              ? `${protocol} port ${result.normalized?.port} found`
              : `${protocol} port not found or unavailable (${result.status})`,
            data: result };
        }
        if (noun === "file") {
          const path = args[1];
          if (!path) return { ok: false, ...base, error: "inspect file needs a path" };
          const result = await probeFile(path, os);
          return { ok: true, ...base,
            detail: result.found
              ? `file ${result.normalized?.path} found`
              : `file not found or unavailable (${result.status})`,
            data: result };
        }
        if (noun === "scheduled-task") {
          if (!opts.name) return { ok: false, ...base, error: "inspect scheduled-task needs --name=<n>" };
          const result = await probeScheduledTask(opts.name, os);
          return { ok: true, ...base,
            detail: result.found
              ? `scheduled task ${result.normalized?.name} found`
              : `scheduled task not found or unavailable (${result.status})`,
            data: result };
        }
        if (noun === "service") {
          if (!opts.name) return { ok: false, ...base, error: "inspect service needs --name=<n>" };
          const result = await probeService(opts.name, os);
          return { ok: true, ...base,
            detail: result.found
              ? `service ${result.normalized?.name} found`
              : `service not found or unavailable (${result.status})`,
            data: result };
        }
        return { ok: false, ...base, error: "inspect needs a noun: process, port, file, service, or scheduled-task" };
      }

      case "type": { await run(typeCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: "typed" }; }
      case "fill": {
        const aimed = opts.window || opts.find || opts.element || opts.role;
        const t = args[1] !== undefined
          ? { x: Number(args[1]), y: Number(args[2]), how: `${args[1]},${args[2]}` }
          : aimed ? await resolveTarget(os, opts, timeoutMs, run) : null;
        if (!t) throw new Error("fill has no target");
        await fillTarget(os, args[0] ?? "", t.x, t.y, run);
        return { ok: true, ...base, detail: `filled at ${t.how}`, data: { x: t.x, y: t.y } };
      }
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
      case "drag": {
        const [fromX, fromY, toX, toY] = args.slice(0, 4).map(Number);
        await execute(dragPlan(os, fromX!, fromY!, toX!, toY!, {
          durationMs: opts.durationMs,
          steps: opts.steps,
        }), run);
        return { ok: true, ...base, detail: `dragged ${fromX},${fromY} to ${toX},${toY}`,
          data: { fromX, fromY, toX, toY } };
      }
      case "click": case "dblclick": {
        const count = action === "dblclick" ? 2 : 1;
        const button = (opts.button ?? "left") as MouseButton;
        const modifiers = normalizeMods(modifierTokens);
        // Coordinates if given; otherwise aim at a window or a picture. A bare
        // click with neither still clicks wherever the cursor already is.
        const aimed = opts.window || opts.find || opts.element || opts.role;
        const t = args[0] !== undefined
          ? { x: Number(args[0]), y: Number(args[1]), how: `${args[0]},${args[1]}` }
          : aimed ? await resolveTarget(os, opts, timeoutMs, run) : null;
        await execute(clickPlan(os, count, t?.x, t?.y, button, modifiers), run);
        return { ok: true, ...base,
          detail: t ? `${action} at ${t.how}` : action,
          ...(t ? { data: { x: t.x, y: t.y } } : {}) };
      }
      case "scroll": {
        const dir = args[0] ?? "down";
        const amount = Number(args[1] ?? 3);
        await execute(scrollPlan(os, dir as "up" | "down" | "left" | "right", amount), run);
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

export const VERSION = "0.2.1";

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
  capture [out.png]            screenshot; --window=<name> captures only that window
  record [n] [gapMs]           n captures in a row
  record <seconds> --video     actual video, where the OS can (not Windows)
  settle [tries] [gapMs] [n]   wait until the screen stops changing
                               (--same-under sets how much noise counts as still)
  diff <a.png> <b.png>         how much changed: SAME or CHANGED

Windows and apps
  launch <app>                 start an app
  focus <name>                 bring a window to the front
  windows                      list visible windows with their rectangles
  frontmost                    which window currently has the keyboard
  wait [gapMs]                 until --element / --window shows up (or --gone)
  element [app]                one control by --element/--role, with its full state
  elements [app]               controls in the accessibility tree: role, name, rect

Finding things
  find <template.png> [in.png] where that picture is: on screen, or in a frame
  crop <in.png> x y w h <out>  cut a template out of a screenshot
  ocr-read <in.png>            recognize text in an image (macOS only, v1)

Batching
  run '<json>'                 several actions in one process, in order
                               [["move",10,20],["click"]] or [{"action":"click"}]
  scenario <path>              run a declarative JSON scenario file

Input
  type <text>                  send text to the focused window
  fill <text> [x] [y]         replace text in an aimed control
  key <chord>                  e.g. cmd+s, ctrl+shift+a, Return
  move <x> <y>                 move the cursor
  click | dblclick [x] [y]     click; or aim with --window / --find
  drag <x1> <y1> <x2> <y2>     hold the button from one point to another
                               (--duration=<ms>, --steps=<n>; defaults 150, 5)
  scroll <up|down|left|right> [amount]
                               scroll the view under the cursor
  select-all | copy | paste    the platform's own chord for each

Other
  os                           which platform this is
  doctor                       bounded, read-only capability checks (macOS)
  serve                        read one command per line, answer one JSON per line
  screen                       frame size, point size, the ratio, and every display

Flags
  --json                       structured Result on stdout
  --timeout=<ms>               deadline for this action
  --duration=<ms>              drag duration (default 150)
  --steps=<n>                  drag interpolation steps (default 5)
  --same-under=<pct>           diff tolerance; 0 means "did anything change"
  --element=<name>             aim at a control by its accessibility name
  --role=<kind>                narrow it: button, text, checkbox, link, ...
  --button=<left|right|middle> mouse button for click / dblclick (default left)
  --modifiers=<chord>          modifiers held during click / dblclick, e.g. ctrl+shift
  --app=<name>                 which application's controls to look at
  --window=<name>              aim at a window instead of a coordinate
  --find=<template.png>        aim at whatever matches this picture
  --at=<fx,fy>                 where inside the target, 0..1 (default centre)
  --min-score=<0..1>           how close a match must be (default 0.9)
  --display=<n>                which screen to capture, 1-based (macOS)
  --depth=<n>                  how deep to walk the accessibility tree (default 12)
  --limit=<n>                  how many controls to return (default 300)
  --video                      record video instead of stills
  --out=<path>                 where to write it
  --gone                       wait for the target to disappear instead
  --expect-front=<name>        refuse to type unless that window is in front
  --force                      act even if the session looks locked
  --help, --version

Exit codes
  0 ok   1 failed   2 bad usage   3 timed out   4 refused (locked or missing dep)`;

/** Exit codes an agent can branch on without parsing prose. */
export function exitCodeFor(r: Result): number {
  if (r.action === "doctor" && r.data && typeof r.data === "object" && "verdict" in r.data) {
    const verdict = r.data.verdict as DoctorVerdict;
    return verdict === "healthy" ? 0 : verdict === "degraded" ? 1 : 4;
  }
  if (r.action === "scenario" && r.data && typeof r.data === "object" &&
      "status" in r.data && r.data.status === "timed_out") return 3;
  if (r.ok) return 0;
  const e = r.error ?? "";
  if (/^unknown action|needs two PNG paths|^ocr-read needs|^fill (needs|coordinates need) |^invalid --button=|^invalid --modifiers=|^invalid scroll direction |^scenario needs|^scenario file not found|^scenario file must contain valid JSON|^invalid scenario at /.test(e)) return 2;
  if (/did not finish within|ran out of time|never went quiet/.test(e)) return 3;
  if (/not found:|DISPLAY is unset|session is locked|no window server session|unsupported (on|platform)/.test(e)) return 4;
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
  const waitWatchdog = action === "wait" ? setTimeout(() => {
    const target: WaitTarget = { element: opts.element, role: opts.role, window: opts.window };
    const budget = opts.timeoutMs ?? 30_000;
    const result: Result = {
      ok: false,
      action: "wait",
      os: detectOS(),
      error: timeoutReason(target, opts.gone ?? false, budget),
      data: { waitedMs: budget },
    };
    console.log(wantJson ? JSON.stringify(result) : `cuse: ${result.error}`);
    process.exit(3);
  }, (opts.timeoutMs ?? 30_000) + 100) : undefined;
  const r = await act(action, args, opts);
  if (waitWatchdog !== undefined) clearTimeout(waitWatchdog);
  console.log(wantJson ? JSON.stringify(r) : r.action === "doctor" ? r.detail : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cuse: ${r.error}`);
  if (!wantJson && r.warn) console.warn(`cuse: warning: ${r.warn}`);
  process.exit(exitCodeFor(r));
}

export { act };
