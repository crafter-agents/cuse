// Can this action actually work on this machine, and if not, why?
// Pure: environment and tool availability are injected, so the reasoning is
// unit-testable without a display or a missing binary.
import type { OS } from "./os.ts";

export type Preflight = { ok: true } | { ok: false; reason: string };

export type Probe = {
  env: Record<string, string | undefined>;
  /** is this executable on PATH? */
  has: (tool: string) => boolean;
};

export const INPUT_ACTIONS = ["type", "key", "move", "scroll", "click", "dblclick", "select-all", "copy", "paste"];

/** Actions that drive a window but are not keystrokes, so no lock guard. */
export const WINDOW_ACTIONS = ["launch", "focus"];

/** Everything that draws or reads the screen needs the same thing on Linux. */
export function displayPreflight(os: OS, probe: Probe): Preflight {
  if (os !== "linux") return { ok: true };
  if (!probe.env.DISPLAY) {
    return { ok: false, reason: "no X display: DISPLAY is unset (run under Xvfb, e.g. `xvfb-run -a cuse ...`)" };
  }
  return { ok: true };
}

/**
 * The tool each action shells out to, when it is not guaranteed to be present.
 *
 * `video` is not an action the CLI takes; it is `record --video`, which needs a
 * recorder rather than a screenshot tool. It is passed here under its own name
 * so that asking for video without ffmpeg names the package, while plain
 * `record` - which takes stills and needs no such thing - is not blocked by it.
 */
export function requiredTool(os: OS, action: string): { tool: string; install: string } | null {
  // macOS records with screencapture itself, and Windows has no recorder to
  // require - `videoCmd` refuses there before anything gets this far.
  if (action === "video") {
    return os === "linux" ? { tool: "ffmpeg", install: "apt-get install -y ffmpeg" } : null;
  }
  // macOS mouse actions go through CoreGraphics in-process, and osascript,
  // screencapture and open all ship with the OS - so nothing to install.
  if (os !== "linux") return null;
  if (action === "capture") return { tool: "xwd", install: "apt-get install -y x11-apps" };
  if ([...INPUT_ACTIONS, "focus"].includes(action)) return { tool: "xdotool", install: "apt-get install -y xdotool" };
  return null;
}

export function preflight(os: OS, action: string, probe: Probe): Preflight {
  if (os === "unknown") return { ok: false, reason: "unsupported platform" };
  const needed = requiredTool(os, action);
  if (needed && !probe.has(needed.tool)) {
    return { ok: false, reason: `\`${needed.tool}\` not found: ${needed.install}` };
  }
  return displayPreflight(os, probe);
}

/**
 * The quiet failure of computer-use: the action succeeds, the screen is empty.
 * A display with nothing drawn on it still yields a correctly sized PNG, and an
 * agent reading only `ok: true` will keep acting against a blank screen.
 *
 * When the frame decodes, `uniform` is the exact answer. When it does not, fall
 * back to bytes-per-pixel: a uniform image compresses to almost nothing, and the
 * two cases sit orders of magnitude apart (observed in CI: 0.0002 B/px on a bare
 * Xvfb against 0.10 and 0.34 on real macOS and Windows sessions).
 */
export function frameWarning(f: { bytes: number; width: number; height: number; uniform?: boolean }): string | undefined {
  const pixels = f.width * f.height;
  if (pixels <= 0) return undefined;
  const blank = f.uniform ?? f.bytes / pixels < 0.005;
  if (!blank) return undefined;
  const how = f.uniform === undefined ? ` (${f.bytes}B for ${f.width}x${f.height})` : "";
  return `frame is blank${how}: the display is on but nothing is drawn on it - ` +
    `input actions will be delivered to no window`;
}
