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

export type Win = { title: string; x: number; y: number; width: number; height: number; app?: string; pid?: number };

/** Convert a window rectangle from input points to captured pixels. */
export function windowCropRect(w: Win, scale: number): { x: number; y: number; width: number; height: number } {
  return {
    x: w.x * scale,
    y: w.y * scale,
    width: w.width * scale,
    height: w.height * scale,
  };
}

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
      'for id in $(xdotool search --onlyvisible --name ".*" 2>/dev/null); do ' +
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
    // macOS gives process and window name; retain both so either can identify
    // the window, falling back to the process when a window is untitled.
    const titleParts = f.slice(0, f.length - 4).filter(Boolean);
    const title = titleParts.length > 1 ? titleParts[1]! : (titleParts[0] ?? "");
    if (width <= 0 || height <= 0) continue;
    out.push({ title, x, y, width, height, ...(titleParts.length > 1 && { app: titleParts[0] }) });
  }
  return out;
}

/**
 * Which window has the keyboard right now?
 *
 * Observed in CI: macOS raised a Screen Recording permission dialog in the
 * middle of a run, it took focus, and every keystroke afterwards went into it
 * while cuse happily reported success. Knowing what is in front is the only way
 * to notice that before typing a password into someone else's dialog.
 */
export function frontmostCmd(os: OS): string[] {
  switch (os) {
    case "macos": return ["osascript", "-e",
      'tell application "System Events"\n' +
      '  set p to first application process whose frontmost is true\n' +
      '  set n to name of p\n' +
      '  try\n' +
      '    set n to n & "\t" & (name of front window of p)\n' +
      '  end try\n' +
      '  return n\n' +
      'end tell'];
    case "linux": return ["sh", "-c",
      'id=$(xdotool getactivewindow 2>/dev/null) || exit 0; xdotool getwindowname "$id" 2>/dev/null'];
    // The focused element is often a control, and a control's name is its
    // content: a text box with "initial line" in it reported exactly that, so
    // the guard was comparing a window title against a document's first line.
    // Walk up to the window and report both.
    case "windows": return ps(
      "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;" +
      "$e=[System.Windows.Automation.AutomationElement]::FocusedElement;" +
      "if($e){" +
      "$w=$e;$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker;" +
      "$guard=0;" +
      "while($w -and $guard -lt 20 -and " +
      "$w.Current.ControlType.ProgrammaticName -ne 'ControlType.Window'){" +
      "$w=$walker.GetParent($w);$guard++};" +
      "$title=if($w){$w.Current.Name}else{''};" +
      "Write-Output (@($title,$e.Current.Name) -join \"`t\")}");
    default: throw new Error(`frontmost unsupported on ${os}`);
  }
}

/** The names the frontmost query prints, process and window, tab separated. */
export function parseFrontmost(text: string): string {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ").replace(/\t/g, " ").trim();
}

/**
 * Is the thing in front the thing we meant to type at?
 *
 * Substring, case-insensitive, matching how windows are named elsewhere. An
 * unreadable answer is not treated as a mismatch: the guard must not block work
 * on a platform that cannot answer the question.
 */
export function frontmostMatches(front: string, expected: string): boolean {
  if (!front) return true;
  return front.toLowerCase().includes(expected.toLowerCase());
}

/** Case-insensitive substring match, the same rule `focus` uses. */
export function pickWindow(wins: Win[], name: string): Win | null {
  const n = name.toLowerCase();
  return wins.find((w) => w.title.toLowerCase().includes(n) || w.app?.toLowerCase().includes(n)) ?? null;
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
