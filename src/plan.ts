// What an input action becomes on each platform. Pure.
//
// Most actions are a shell command, but macOS has no scriptable mouse: System
// Events cannot move the cursor or click, so those go through CoreGraphics
// in-process instead of argv. The plan type makes that difference explicit and
// still testable from any machine.
import { hasMod, normalizeMods, type OS } from "./os.ts";

export type MouseButton = "left" | "right" | "middle";

export type Plan =
  | { kind: "exec"; argv: string[] }
  | { kind: "exec-many"; argvs: string[][] }
  | { kind: "native"; op: "warp"; x: number; y: number }
  | { kind: "native"; op: "click"; x?: number; y?: number; count: number; button: MouseButton; mods: string[] }
  | { kind: "native"; op: "drag"; fromX: number; fromY: number; toX: number; toY: number;
      durationMs: number; steps: number }
  | { kind: "native"; op: "scroll"; axis: "vertical" | "horizontal"; lines: number };

const ps = (script: string) => ["powershell", "-NoProfile", "-Command", script];

// Windows has no cursor-click cmdlet; mouse_event is the documented user32 call.
const WIN_BUTTON_FLAGS: Record<MouseButton, [number, number]> = {
  left: [0x0002, 0x0004],
  right: [0x0008, 0x0010],
  middle: [0x0020, 0x0040],
};

const WIN_CLICK = (count: number, x?: number, y?: number, button: MouseButton = "left",
                   modifiers: string[] = []) => {
  const mods = normalizeMods(modifiers);
  const keys = [
    ...(hasMod(mods, "ctrl") || hasMod(mods, "cmd") ? [0x11] : []),
    ...(hasMod(mods, "shift") ? [0x10] : []),
    ...(hasMod(mods, "alt") ? [0x12] : []),
  ];
  return ps(
  // Load the assembly before using a type from it, and stop on error rather
  // than carrying on. Written the other way round, the cursor move referenced
  // System.Windows.Forms before Add-Type had loaded it: PowerShell reported a
  // non-terminating error, exited 0, and mouse_event clicked wherever the
  // cursor already was. cuse said ok and nothing had been pressed.
  `$ErrorActionPreference='Stop';` +
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
  `Add-Type 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);[DllImport("user32.dll")]public static extern void keybd_event(byte v,byte s,uint f,int e);}';` +
  (x !== undefined ? `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});Start-Sleep -Milliseconds 60;` : "") +
  keys.map((key) => `[M]::keybd_event(${key},0,0,0);`).join("") +
  Array.from({ length: count }, () => `[M]::mouse_event(${WIN_BUTTON_FLAGS[button][0]},0,0,0,0);Start-Sleep -Milliseconds 40;[M]::mouse_event(${WIN_BUTTON_FLAGS[button][1]},0,0,0,0);`).join("Start-Sleep -Milliseconds 60;") +
  keys.toReversed().map((key) => `[M]::keybd_event(${key},0,2,0);`).join(""));
};

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

export function clickPlan(os: OS, count: number, x?: number, y?: number,
                          button: MouseButton = "left", modifiers: string[] = []): Plan {
  const mods = normalizeMods(modifiers);
  switch (os) {
    case "macos": return { kind: "native", op: "click", x, y, count, button, mods };
    case "linux": {
      const argvs: string[][] = [];
      if (x !== undefined) argvs.push(["xdotool", "mousemove", String(x), String(y)]);
      const number: Record<MouseButton, string> = { left: "1", middle: "2", right: "3" };
      const keys = mods.map((mod) => mod === "cmd" ? "super" : mod);
      if (keys.length) argvs.push(["xdotool", "keydown", ...keys]);
      argvs.push(["xdotool", "click", "--repeat", String(count), number[button]]);
      if (keys.length) argvs.push(["xdotool", "keyup", ...keys.toReversed()]);
      return { kind: "exec-many", argvs };
    }
    case "windows": return { kind: "exec", argv: WIN_CLICK(count, x, y, button, mods) };
    default: throw new Error(`click unsupported on ${os}`);
  }
}

export type DragOptions = { durationMs?: number; steps?: number };

// Five moves over 150 ms stays near the old Windows drag's 180 ms while every
// backend now exposes enough motion for targets that observe pointer events.
const DEFAULT_DRAG_DURATION_MS = 150;
const DEFAULT_DRAG_STEPS = 5;

export function dragPlan(os: OS, fromX: number, fromY: number, toX: number, toY: number,
                         opts: DragOptions = {}): Plan {
  for (const [name, value] of Object.entries({ fromX, fromY, toX, toY })) {
    if (!Number.isFinite(value)) throw new Error(`drag ${name} must be a finite number`);
  }
  const durationMs = opts.durationMs ?? DEFAULT_DRAG_DURATION_MS;
  const steps = opts.steps ?? DEFAULT_DRAG_STEPS;
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("drag durationMs must be a finite positive number");
  }
  if (!Number.isSafeInteger(steps) || steps <= 0) {
    throw new Error("drag steps must be a finite positive integer");
  }

  const delayMs = durationMs / steps;
  const waypoints = Array.from({ length: steps }, (_, index) => {
    const progress = (index + 1) / steps;
    return [fromX + (toX - fromX) * progress, fromY + (toY - fromY) * progress] as const;
  });

  switch (os) {
    case "macos": return { kind: "native", op: "drag", fromX, fromY, toX, toY, durationMs, steps };
    case "linux": return { kind: "exec-many", argvs: [
      ["xdotool", "mousemove", String(fromX), String(fromY)],
      ["xdotool", "mousedown", "1"],
      ...waypoints.flatMap(([x, y]) => [
        ["sleep", String(delayMs / 1000)],
        ["xdotool", "mousemove", String(x), String(y)],
      ]),
      ["xdotool", "mouseup", "1"],
    ] };
    case "windows": return { kind: "exec", argv: ps(
      `$ErrorActionPreference='Stop';` +
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
      `Add-Type 'using System;using System.Runtime.InteropServices;public class M{[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,int e);}';` +
      `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${fromX},${fromY});` +
      `[M]::mouse_event(2,0,0,0,0);` +
      waypoints.map(([x, y]) =>
        `Start-Sleep -Milliseconds ${delayMs};` +
        `[System.Windows.Forms.Cursor]::Position=New-Object System.Drawing.Point(${x},${y});`).join("") +
      `[M]::mouse_event(4,0,0,0,0);`) };
    default: throw new Error(`drag unsupported on ${os}`);
  }
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export function scrollPlan(os: OS, dir: ScrollDirection, amount: number): Plan {
  const axis = dir === "up" || dir === "down" ? "vertical" : "horizontal";
  const lines = dir === "up" || dir === "left" ? amount : -amount;
  switch (os) {
    // A real wheel event, not a Page Down impersonating one: it scrolls the view
    // under the cursor without needing a text caret or a focused document.
    case "macos": return { kind: "native", op: "scroll", axis, lines };
    case "linux": return { kind: "exec-many", argvs:
      Array.from({ length: amount }, () => ["xdotool", "click",
        ({ up: "4", down: "5", left: "6", right: "7" } as const)[dir]]) };
    case "windows": {
      if (axis === "horizontal") throw new Error(`scroll ${dir} unsupported on windows`);
      return { kind: "exec-many", argvs:
        Array.from({ length: amount }, () => ps(
          `Add-Type -AssemblyName System.Windows.Forms;` +
          `[System.Windows.Forms.SendKeys]::SendWait('{${dir === "up" ? "PGUP" : "PGDN"}}')`)) };
    }
    default: throw new Error(`scroll unsupported on ${os}`);
  }
}
