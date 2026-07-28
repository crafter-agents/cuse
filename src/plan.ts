// What an input action becomes on each platform. Pure.
//
// Most actions are a shell command, but macOS has no scriptable mouse: System
// Events cannot move the cursor or click, so those go through CoreGraphics
// in-process instead of argv. The plan type makes that difference explicit and
// still testable from any machine.
import type { OS } from "./os.ts";

export type Plan =
  | { kind: "exec"; argv: string[] }
  | { kind: "exec-many"; argvs: string[][] }
  | { kind: "native"; op: "warp"; x: number; y: number }
  | { kind: "native"; op: "click"; x?: number; y?: number; count: number }
  | { kind: "native"; op: "scroll"; lines: number };

const ps = (script: string) => ["powershell", "-NoProfile", "-Command", script];

// Windows has no cursor-click cmdlet; mouse_event is the documented user32 call.
const WIN_CLICK = (count: number, x?: number, y?: number) => ps(
  // Load the assembly before using a type from it, and stop on error rather
  // than carrying on. Written the other way round, the cursor move referenced
  // System.Windows.Forms before Add-Type had loaded it: PowerShell reported a
  // non-terminating error, exited 0, and mouse_event clicked wherever the
  // cursor already was. cuse said ok and nothing had been pressed.
  `$ErrorActionPreference='Stop';` +
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
  `Add-Type 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);}';` +
  (x !== undefined ? `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});Start-Sleep -Milliseconds 60;` : "") +
  Array.from({ length: count }, () => `[M]::mouse_event(2,0,0,0,0);Start-Sleep -Milliseconds 40;[M]::mouse_event(4,0,0,0,0);`).join("Start-Sleep -Milliseconds 60;"));

export function movePlan(os: OS, x: number, y: number): Plan {
  switch (os) {
    case "macos": return { kind: "native", op: "warp", x, y };
    case "linux": return { kind: "exec", argv: ["xdotool", "mousemove", String(x), String(y)] };
    case "windows": return { kind: "exec", argv: ps(
      `$ErrorActionPreference='Stop';` +
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y})`) };
    default: throw new Error(`move unsupported on ${os}`);
  }
}

export function clickPlan(os: OS, count: number, x?: number, y?: number): Plan {
  switch (os) {
    case "macos": return { kind: "native", op: "click", x, y, count };
    case "linux": {
      const argvs: string[][] = [];
      if (x !== undefined) argvs.push(["xdotool", "mousemove", String(x), String(y)]);
      argvs.push(["xdotool", "click", "--repeat", String(count), "1"]);
      return { kind: "exec-many", argvs };
    }
    case "windows": return { kind: "exec", argv: WIN_CLICK(count, x, y) };
    default: throw new Error(`click unsupported on ${os}`);
  }
}

export function scrollPlan(os: OS, dir: "up" | "down", amount: number): Plan {
  const lines = dir === "up" ? amount : -amount;
  switch (os) {
    // A real wheel event, not a Page Down impersonating one: it scrolls the view
    // under the cursor without needing a text caret or a focused document.
    case "macos": return { kind: "native", op: "scroll", lines };
    case "linux": return { kind: "exec-many", argvs:
      Array.from({ length: amount }, () => ["xdotool", "click", dir === "up" ? "4" : "5"]) };
    case "windows": return { kind: "exec-many", argvs:
      Array.from({ length: amount }, () => ps(
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `[System.Windows.Forms.SendKeys]::SendWait('{${dir === "up" ? "PGUP" : "PGDN"}}')`)) };
    default: throw new Error(`scroll unsupported on ${os}`);
  }
}
