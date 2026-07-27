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

/** Every action below the screenshot needs the same thing on Linux: an X display. */
export function displayPreflight(os: OS, probe: Probe): Preflight {
  if (os !== "linux") return { ok: true };
  if (!probe.env.DISPLAY) {
    return { ok: false, reason: "no X display: DISPLAY is unset (run under Xvfb, e.g. `xvfb-run -a cu ...`)" };
  }
  return { ok: true };
}

/** The tool each action shells out to, when it is not guaranteed present. */
export function requiredTool(os: OS, action: string): { tool: string; install: string } | null {
  if (os !== "linux") return null; // screencapture/osascript ship with macOS; powershell with Windows
  if (action === "capture") return { tool: "import", install: "apt-get install -y imagemagick" };
  if (["type", "key", "move", "scroll", "click", "select-all", "copy", "paste"].includes(action)) {
    return { tool: "xdotool", install: "apt-get install -y xdotool" };
  }
  return null;
}

/**
 * The quiet failure of computer-use: capture succeeds, the frame is blank. A
 * display with nothing drawn on it still yields a correctly sized PNG, and an
 * agent reading only `ok: true` will keep acting against an empty screen.
 *
 * A uniform image compresses to almost nothing, so bytes-per-pixel separates
 * the two cases by orders of magnitude. Observed in CI: a blank Xvfb frame is
 * 0.0002 B/px, real macOS and Windows sessions are 0.10 and 0.34. This is a
 * heuristic, so it warns - it never turns a successful capture into a failure.
 */
export function blankFrameWarning(bytes: number, width: number, height: number): string | undefined {
  const pixels = width * height;
  if (pixels <= 0) return undefined;
  const bpp = bytes / pixels;
  if (bpp < 0.005) {
    return `frame looks blank (${bytes}B for ${width}x${height}): the display is on but nothing is drawn on it`;
  }
  return undefined;
}

export function preflight(os: OS, action: string, probe: Probe): Preflight {
  if (os === "unknown") return { ok: false, reason: `unsupported platform` };
  const needed = requiredTool(os, action);
  if (needed && !probe.has(needed.tool)) {
    return { ok: false, reason: `\`${needed.tool}\` not found: ${needed.install}` };
  }
  return displayPreflight(os, probe);
}
