#!/usr/bin/env bun
// cu - cross-platform computer-use CLI. One verb, the right OS primitive.
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

export type Options = { force?: boolean; sameUnder?: number; timeoutMs?: number };

export type Result = {
  ok: boolean; action: string; os: OS;
  detail?: string; error?: string; warn?: string; data?: unknown;
};

/**
 * Run a command under a deadline, and on failure report what the OS said.
 *
 * Both halves matter. Bun's default throw carries only an exit code, which
 * turns "no window matching 'Notepad'" into "Failed with exit code 1"; and
 * without a timeout a wedged backend hangs the agent driving cu, which has no
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
 * stdout, which cu converts - that is what removes the imagemagick dependency.
 */
async function captureTo(os: OS, out: string, timeoutMs: number,
                         run: (argv: string[]) => Promise<void>): Promise<void> {
  const argv = captureCmd(os, out);
  if (os !== "linux") return run(argv);
  const r = await runBytes(argv, timeoutMs);
  const problem = explainFailure(argv, r, timeoutMs);
  if (problem) throw new Error(problem);
  if (r.stdout.length === 0) throw new Error("xwd produced no dump (is DISPLAY reachable?)");
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
        const frames = [resolve("settle-a.png"), resolve("settle-b.png")];
        let cur = 0, streak = 0, last;
        await run(captureCmd(os, frames[cur]!));
        for (let i = 1; i <= tries; i++) {
          if (Date.now() > deadline) {
            return { ok: false, ...base, error: `settle ran out of time after ${i - 1} checks` };
          }
          await Bun.sleep(gapMs);
          const next = 1 - cur;
          await captureTo(os, frames[next]!, timeoutMs, run);
          last = diffImages(await loadImage(frames[cur]!), await loadImage(frames[next]!), 30, 0);
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
        await execute(movePlan(os, Number(args[0]), Number(args[1])), run);
        return { ok: true, ...base, detail: `moved ${args[0]},${args[1]}` };
      }
      case "click": case "dblclick": {
        const count = action === "dblclick" ? 2 : 1;
        const at = xy(args[0], args[1]);
        await execute(clickPlan(os, count, at.x, at.y), run);
        return { ok: true, ...base, detail: at.x === undefined ? action : `${action} at ${at.x},${at.y}` };
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

const HELP = `cu ${VERSION} - cross-platform computer-use CLI

  cu <action> [args] [flags]

Screen
  capture [out.png]            screenshot; warns when the frame is blank
  record [n] [gapMs]           n captures in a row
  settle [tries] [gapMs] [n]   wait until the screen stops changing
  diff <a.png> <b.png>         how much changed: SAME or CHANGED

Windows and apps
  launch <app>                 start an app
  focus <name>                 bring a window to the front

Input
  type <text>                  send text to the focused window
  key <chord>                  e.g. cmd+s, ctrl+shift+a, Return
  move <x> <y>                 move the cursor
  click | dblclick [x] [y]     click, optionally at a point
  scroll <up|down> [amount]    scroll the view under the cursor
  select-all | copy | paste    the platform's own chord for each

Other
  os                           which platform this is

Flags
  --json                       structured Result on stdout
  --timeout=<ms>               deadline for this action
  --same-under=<pct>           diff tolerance; 0 means "did anything change"
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
  const [action, ...args] = argv.filter((a) => !a.startsWith("--"));
  const r = await act(action ?? "", args, { force, sameUnder, timeoutMs });
  console.log(json ? JSON.stringify(r) : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cu: ${r.error}`);
  if (!json && r.warn) console.warn(`cu: warning: ${r.warn}`);
  process.exit(exitCodeFor(r));
}

export { act };
