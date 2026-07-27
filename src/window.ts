// What is on screen, and where.
//
// A browser agent has selectors; a desktop agent has a screenshot and no idea
// what any of it is. Window enumeration is the first half of closing that gap:
// every OS can say which windows exist and what rectangle each one occupies,
// which turns "click at 812,437" into "click the middle of CU_TARGET".
//
// Builders and parsers are pure; the CLI runs the command and feeds the output
// back in, so the awkward per-OS text formats are testable without a desktop.
import type { OS } from "./os.ts";

export type Win = { title: string; x: number; y: number; width: number; height: number; pid?: number };

const ps = (script: string) => ["powershell", "-NoProfile", "-Command", script];

/** Each OS can list its windows; none of them agree on how. */
export function listWindowsCmd(os: OS): string[] {
  switch (os) {
    // System Events reports position and size as AppleScript lists; one line
    // per window keeps the parsing honest when a title contains a comma.
    case "macos": return ["osascript", "-e",
      'set out to ""\n' +
      'tell application "System Events"\n' +
      '  repeat with p in (every application process whose visible is true)\n' +
      '    repeat with w in (every window of p)\n' +
      '      try\n' +
      '        set b to position of w\n' +
      '        set s to size of w\n' +
      '        set out to out & (name of p) & "\\t" & (name of w) & "\\t" & (item 1 of b) & "\\t" & (item 2 of b) & "\\t" & (item 1 of s) & "\\t" & (item 2 of s) & "\\n"\n' +
      '      end try\n' +
      '    end repeat\n' +
      '  end repeat\n' +
      'end tell\n' +
      'return out'];
    // xdotool prints geometry as key=value blocks; asking per window keeps it
    // parseable and works without a window manager.
    case "linux": return ["sh", "-c",
      'for id in $(xdotool search --onlyvisible --name "" 2>/dev/null); do ' +
      'name=$(xdotool getwindowname "$id" 2>/dev/null); ' +
      'eval "$(xdotool getwindowgeometry --shell "$id" 2>/dev/null)"; ' +
      '[ -n "$WIDTH" ] && printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$name" "$X" "$Y" "$WIDTH" "$HEIGHT"; ' +
      'done'];
    // UI Automation is the only Windows API that reports a bounding rectangle
    // for a window it did not create.
    case "windows": return ps(
      "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;" +
      "$root=[System.Windows.Automation.AutomationElement]::RootElement;" +
      "$cond=New-Object System.Windows.Automation.PropertyCondition(" +
      "[System.Windows.Automation.AutomationElement]::ControlTypeProperty," +
      "[System.Windows.Automation.ControlType]::Window);" +
      "foreach($w in $root.FindAll('Children',$cond)){" +
      "$r=$w.Current.BoundingRectangle;" +
      "if($r.Width -gt 0){" +
      "Write-Output ((@($w.Current.Name,[int]$r.X,[int]$r.Y,[int]$r.Width,[int]$r.Height)) -join \"`t\")}}");
    default: throw new Error(`window listing unsupported on ${os}`);
  }
}

/**
 * Parse the tab-separated lines each backend produces.
 *
 * macOS emits a leading process name, the others do not; the row length says
 * which, so one parser covers all three.
 */
export function parseWindows(text: string): Win[] {
  const out: Win[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("\t").map((s) => s.trim());
    if (f.length < 5) continue;
    const nums = f.slice(-4).map(Number);
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const [x, y, width, height] = nums as [number, number, number, number];
    // macOS gives process and window name; prefer the window's own, falling
    // back to the process when a window is untitled (dialogs often are).
    const titleParts = f.slice(0, f.length - 4).filter(Boolean);
    const title = titleParts.length > 1 ? titleParts[1]! : (titleParts[0] ?? "");
    if (width <= 0 || height <= 0) continue;
    out.push({ title, x, y, width, height });
  }
  return out;
}

/** Case-insensitive substring match, the same rule `focus` uses. */
export function pickWindow(wins: Win[], name: string): Win | null {
  const n = name.toLowerCase();
  return wins.find((w) => w.title.toLowerCase().includes(n)) ?? null;
}

/**
 * A point inside a window, from fractions of its size.
 *
 * Fractions rather than pixels so a script survives the window opening at a
 * different place or size, which on a fresh runner it usually does.
 */
export function pointIn(w: Win, fx = 0.5, fy = 0.5): { x: number; y: number } {
  return {
    x: Math.round(w.x + w.width * fx),
    y: Math.round(w.y + w.height * fy),
  };
}
