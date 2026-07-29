// How many screens there are, and which part of them a capture covers.
//
// cuse used to answer both questions with one number: `screen` reported a frame
// and a scale, and everything that turned a pixel into a click assumed the frame
// started at 0,0 and held everything. On one monitor that is true. On two it is
// wrong in a way nothing reports:
//
//   - Windows captures the whole virtual screen, whose origin is negative when a
//     monitor sits left of or above the primary one. A template found 40px into
//     that frame is not at screen x=40, it is at x=-1880. The click landed on the
//     wrong monitor and every layer called it a success.
//   - macOS `screencapture` writes one file per screen, so asking for one file
//     gets the main display and nothing else. A window on the second monitor is
//     simply not in the frame, and `find` says "not on screen" about a thing that
//     plainly is.
//   - Linux draws every monitor into one root window, so the frame does start at
//     0,0 and does hold everything. That is the only case the old assumption fit.
//
// So the frame's origin is carried rather than assumed, and the parts of the desk
// a capture cannot see are reported instead of quietly excluded.
import type { OS } from "./os.ts";

/** A screen, in the top-left coordinate space that clicks use. */
export type Display = {
  x: number; y: number; width: number; height: number;
  primary: boolean;
  name?: string;
};

export type Rect = { x: number; y: number; width: number; height: number };

const ps = (script: string) => ["powershell", "-NoProfile", "-Command", script];

/** Ask the platform what screens are attached. */
export function displaysCmd(os: OS): string[] {
  switch (os) {
    // NSScreen through JXA: no framework to install, no compiler, and it is the
    // same list every Cocoa app sees. Its origin is bottom-left, which the
    // parser converts - see below, that flip is the whole reason this is not
    // three lines.
    case "macos": return ["osascript", "-l", "JavaScript", "-e",
      'ObjC.import("AppKit");' +
      "const s = $.NSScreen.screens, out = [];" +
      "for (let i = 0; i < s.count; i++) {" +
      "  const f = s.objectAtIndex(i).frame;" +
      "  out.push([f.origin.x, f.origin.y, f.size.width, f.size.height].join('\\t'));" +
      "}" +
      "out.join('\\n')"];
    // RandR knows the monitor layout; the root window is their union. xrandr is
    // not always installed, and an empty answer here is not fatal - the frame
    // covers everything on this platform either way.
    case "linux": return ["sh", "-c",
      "xrandr --listmonitors 2>/dev/null || true"];
    case "windows": return ps(
      "Add-Type -AssemblyName System.Windows.Forms;" +
      "foreach($s in [System.Windows.Forms.Screen]::AllScreens){" +
      "$b=$s.Bounds;" +
      "Write-Output ((@([int]$b.X,[int]$b.Y,[int]$b.Width,[int]$b.Height," +
      "$(if($s.Primary){1}else{0}),$s.DeviceName)) -join \"`t\")}");
    default: throw new Error(`display listing unsupported on ${os}`);
  }
}

/**
 * Read whatever shape each platform answered in.
 *
 * The macOS branch is the one with a trap in it. NSScreen measures from the
 * bottom-left of the main screen and clicks are measured from the top-left, so
 * a second monitor's y has to be flipped through the main screen's height.
 * Getting this wrong is invisible on a laptop - with one screen the flip is the
 * identity - and puts every click on the wrong row with two.
 */
export function parseDisplays(text: string, os: OS): Display[] {
  const rows = text.split("\n").map((l) => l.trim()).filter(Boolean);

  if (os === "linux") {
    // "Monitors: 2" then " 0: +*HDMI-1 1920/509x1080/286+0+0  HDMI-1"
    const out: Display[] = [];
    for (const line of rows) {
      const m = /^\d+:\s+\+(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+\+(-?\d+)\+(-?\d+)/.exec(line);
      if (!m) continue;
      out.push({
        x: Number(m[5]), y: Number(m[6]), width: Number(m[3]), height: Number(m[4]),
        primary: m[1] === "*", name: m[2],
      });
    }
    // xrandr marks the primary with a star; with none marked, the first monitor
    // is as good an answer as the layout allows.
    if (out.length && !out.some((d) => d.primary)) out[0]!.primary = true;
    return out;
  }

  if (os === "windows") {
    const out: Display[] = [];
    for (const line of rows) {
      const f = line.split("\t");
      if (f.length < 5) continue;
      const n = f.slice(0, 4).map(Number);
      if (n.some((v) => !Number.isFinite(v))) continue;
      out.push({
        x: n[0]!, y: n[1]!, width: n[2]!, height: n[3]!,
        primary: f[4]!.trim() === "1", name: f[5]?.trim(),
      });
    }
    return out;
  }

  // macOS: x, y, width, height in NSScreen's bottom-left space.
  const raw: Rect[] = [];
  for (const line of rows) {
    const n = line.split("\t").map((v) => Number(v.trim()));
    if (n.length < 4 || n.some((v) => !Number.isFinite(v))) continue;
    raw.push({ x: n[0]!, y: n[1]!, width: n[2]!, height: n[3]! });
  }
  if (!raw.length) return [];
  // NSScreen.screens[0] is the screen holding the menu bar, and the one whose
  // origin is 0,0. Everything else is measured from its bottom-left corner.
  const main = raw[0]!;
  return raw.map((r, i) => ({
    x: r.x,
    y: main.height - (r.y + r.height),
    width: r.width, height: r.height,
    primary: i === 0,
  }));
}

/**
 * Where the captured frame's top-left pixel is, in screen coordinates.
 *
 * Windows copies the whole virtual screen starting at its own origin, which is
 * negative whenever a monitor is left of or above the primary. Linux captures
 * the root window, which starts at 0,0. macOS captures one display, and cuse
 * captures the main one, which is also 0,0.
 */
export function frameOrigin(displays: Display[], os: OS, display?: number): { x: number; y: number } {
  // A capture of a chosen screen starts at that screen, wherever it sits.
  if (display && display >= 1 && displays[display - 1]) {
    const d = displays[display - 1]!;
    return { x: d.x, y: d.y };
  }
  if (os !== "windows" || !displays.length) return { x: 0, y: 0 };
  return {
    x: Math.min(...displays.map((d) => d.x)),
    y: Math.min(...displays.map((d) => d.y)),
  };
}

/** Which displays a frame taken at this origin does not contain. */
export function outsideFrame(displays: Display[], frame: Rect): Display[] {
  return displays.filter((d) =>
    d.x < frame.x || d.y < frame.y ||
    d.x + d.width > frame.x + frame.width ||
    d.y + d.height > frame.y + frame.height);
}

/**
 * What to say when the capture is not the whole desk.
 *
 * An agent that cannot find a button needs to know the button may be on a
 * screen this frame never included; "not on screen" would be a lie.
 */
export function coverageWarning(displays: Display[], frame: Rect): string | undefined {
  if (displays.length < 2) return undefined;
  const missed = outsideFrame(displays, frame);
  if (!missed.length) return undefined;
  const which = missed
    .map((d) => `${d.width}x${d.height} at ${d.x},${d.y}`)
    .join("; ");
  return `${displays.length} displays are attached and this frame covers ${
    displays.length - missed.length} of them - not in it: ${which}`;
}

/** Frame pixel to screen point: undo the capture's density, then its origin. */
export function toScreenPoint(px: number, py: number, scale: number,
                              origin: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.round(origin.x + px / scale),
    y: Math.round(origin.y + py / scale),
  };
}

/** The rectangle every attached display fits inside. */
export function desktopBounds(displays: Display[]): Rect | null {
  if (!displays.length) return null;
  const x = Math.min(...displays.map((d) => d.x));
  const y = Math.min(...displays.map((d) => d.y));
  return {
    x, y,
    width: Math.max(...displays.map((d) => d.x + d.width)) - x,
    height: Math.max(...displays.map((d) => d.y + d.height)) - y,
  };
}
