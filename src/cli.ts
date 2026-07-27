#!/usr/bin/env bun
// cu - cross-platform computer-use CLI. One verb, the right OS primitive.
// Structured Result + --json. Actions delegate to pure builders (tested).
import { $ } from "bun";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { detectOS, chordToOS, type OS } from "./os.ts";
import { captureCmd, typeCmd, launchCmd, comboKey } from "./commands.ts";
import { movePlan, clickPlan, scrollPlan, type Plan } from "./plan.ts";
import { preflight, frameWarning, INPUT_ACTIONS, type Probe } from "./preflight.ts";
import { isSessionLocked, LOCK_QUERY, LOCKED_REASON } from "./session.ts";
import { decodePNG, diffImages, isUniform, readHeader, type Image } from "./png.ts";

export type Result = {
  ok: boolean; action: string; os: OS;
  detail?: string; error?: string; warn?: string; data?: unknown;
};

async function run(argv: string[]): Promise<void> { await $`${argv}`.quiet(); }

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

async function act(action: string, args: string[], force = false): Promise<Result> {
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

      case "diff": {
        const [a, b] = [args[0], args[1]];
        if (!a || !b) return { ok: false, ...base, error: "diff needs two PNG paths" };
        const d = diffImages(await loadImage(a), await loadImage(b));
        return { ok: true, ...base, detail: `changed ${d.percent}% - ${d.verdict}`, data: d };
      }

      case "type": { await run(typeCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: "typed" }; }
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
  const [action, ...args] = argv.filter((a) => a !== "--json" && a !== "--force");
  const r = await act(action ?? "", args, force);
  console.log(json ? JSON.stringify(r) : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cu: ${r.error}`);
  if (!json && r.warn) console.warn(`cu: warning: ${r.warn}`);
  process.exit(r.ok ? 0 : 1);
}

export { act };
