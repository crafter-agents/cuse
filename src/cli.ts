#!/usr/bin/env bun
// cu — cross-platform computer-use CLI. One verb, the right OS primitive.
// Structured Result + --json. Actions delegate to pure command builders (tested).
import { $ } from "bun";
import { detectOS, chordToOS, type OS } from "./os.ts";
import { captureCmd, typeCmd, launchCmd, moveCmd, scrollCmd, comboKey } from "./commands.ts";
import { preflight, type Probe } from "./preflight.ts";

export type Result = { ok: boolean; action: string; os: OS; detail?: string; error?: string };

async function run(cmd: string[]): Promise<void> { await $`${cmd}`.quiet(); }

const probe: Probe = { env: process.env, has: (tool) => Bun.which(tool) !== null };

async function act(action: string, args: string[]): Promise<Result> {
  const os = detectOS();
  const base = { action, os };

  // Fail before touching the machine, with the reason and the fix, not an opaque
  // exit code from a missing binary or an absent display.
  if (action !== "os") {
    const pre = preflight(os, action, probe);
    if (!pre.ok) return { ok: false, ...base, error: pre.reason };
  }

  try {
    switch (action) {
      case "os": return { ok: true, ...base, detail: os };
      case "capture": {
        const out = args[0] ?? "out.png";
        await run(captureCmd(os, out));
        const size = (await Bun.file(out).exists()) ? Bun.file(out).size : 0;
        return size > 0 ? { ok: true, ...base, detail: `${size}B -> ${out}` } : { ok: false, ...base, error: "no file produced" };
      }
      case "type": { await run(typeCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: "typed" }; }
      case "launch": { await run(launchCmd(os, args[0] ?? "")); return { ok: true, ...base, detail: `launched ${args[0]}` }; }
      case "key": { await run(chordToOS(os, args[0] ?? "").cmd); return { ok: true, ...base, detail: `sent ${args[0]}` }; }
      case "move": { await run(moveCmd(os, Number(args[0]), Number(args[1]))); return { ok: true, ...base, detail: `moved ${args[0]},${args[1]}` }; }
      case "scroll": { for (const c of scrollCmd(os, (args[0] as "up"|"down") ?? "down", Number(args[1] ?? 3))) await run(c); return { ok: true, ...base, detail: `scrolled ${args[0]}` }; }
      case "select-all": case "copy": case "paste": {
        await run(chordToOS(os, comboKey(os, action)).cmd); return { ok: true, ...base, detail: action };
      }
      default: return { ok: false, ...base, error: `unknown action '${action}'` };
    }
  } catch (e) { return { ok: false, ...base, error: String(e) }; }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const [action, ...args] = argv.filter((a) => a !== "--json");
  const r = await act(action ?? "", args);
  console.log(json ? JSON.stringify(r) : r.ok ? `${r.action}: ${r.detail ?? "ok"}` : `cu: ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}

export { act };
