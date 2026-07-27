#!/usr/bin/env bun
// cu - cross-platform computer-use CLI. One verb, the right OS primitive.
// Structured Result + --json. Actions delegate to pure builders (tested).
import { $ } from "bun";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { detectOS, chordToOS, type OS } from "./os.ts";
import { captureCmd, typeCmd, launchCmd, focusCmd, comboKey } from "./commands.ts";
import { movePlan, clickPlan, scrollPlan, type Plan } from "./plan.ts";
import { preflight, frameWarning, INPUT_ACTIONS, type Probe } from "./preflight.ts";
import { isSessionLocked, LOCK_QUERY, LOCKED_REASON } from "./session.ts";
import { decodePNG, diffImages, isUniform, readHeader, type Image } from "./png.ts";

export type Result = {
  ok: boolean; action: string; os: OS;
  detail?: string; error?: string; warn?: string; data?: unknown;
};

/**
 * Run a command, and on failure report what the OS actually said.
 *
 * Bun's default throw carries only the exit code, which turns a precise message
 * ("no window matching 'Notepad'") into "Failed with exit code 1" - useless to
 * the agent that has to decide what to do next.
 */
async function run(argv: string[]): Promise<void> {
  const r = await $`${argv}`.quiet().nothrow();
  if (r.exitCode === 0) return;
  // The first line is the message; what follows is the interpreter's own trace.
  const said = (r.stderr.toString() || r.stdout.toString()).trim().split("\n").map((l) => l.trim()).filter(Boolean)[0];
  throw new Error(said ? `${argv[0]}: ${said}` : `${argv[0]} exited ${r.exitCode}`);
}

/** Execute a plan. The macOS branch is loaded lazily so that importing the CLI
 *  on Linux or Windows never touches bun:ffi or a framework that is not there. */
async function execute(plan: Plan): Promise<void> {
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
  try {
    return await $`${query}`.quiet().text();
  } catch {
    return null;
  }
}

const xy = (a?: string, b?: string) =>
  a === undefined ? {} : { x: Number(a), y: Number(b) };

async function act(action: string, args: string[], force = false, sameUnder = 1): Promise<Result> {
  const os = detectOS();
  const base = { action, os };

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
        await run(captureCmd(os, out));
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
          await run(captureCmd(os, out));
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
        const tries = Number(args[0] ?? 30);
        const gapMs = Number(args[1] ?? 500);
        const needed = Number(args[2] ?? 3);
        const frames = [resolve("settle-a.png"), resolve("settle-b.png")];
        let cur = 0, streak = 0, last;
        await run(captureCmd(os, frames[cur]!));
        for (let i = 1; i <= tries; i++) {
          await Bun.sleep(gapMs);
          const next = 1 - cur;
          await run(captureCmd(os, frames[next]!));
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
        await execute(movePlan(os, Number(args[0]), Number(args[1])));
        return { ok: true, ...base, detail: `moved ${args[0]},${args[1]}` };
      }
      case "click": case "dblclick": {
        const count = action === "dblclick" ? 2 : 1;
        const at = xy(args[0], args[1]);
        await execute(clickPlan(os, count, at.x, at.y));
        return { ok: true, ...base, detail: at.x === undefined ? action : `${action} at ${at.x},${at.y}` };
      }
      case "scroll": {
        const dir = (args[0] as "up" | "down") ?? "down";
        const amount = Number(args[1] ?? 3);
        await execute(scrollPlan(os, dir, amount));
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

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const force = argv.includes("--force");
  const su = argv.find((a) => a.startsWith("--same-under="));
  const sameUnder = su ? Number(su.split("=")[1]) : 1;
  const [action, ...args] = argv.filter((a) => !a.startsWith("--"));
  const r = await act(action ?? "", args, force, sameUnder);
  console.log(json ? JSON.stringify(r) : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cu: ${r.error}`);
  if (!json && r.warn) console.warn(`cu: warning: ${r.warn}`);
  process.exit(r.ok ? 0 : 1);
}

export { act };
