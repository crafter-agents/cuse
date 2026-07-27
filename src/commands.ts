// Pure command builders: each action -> the exact argv per OS. No side effects,
// so every mapping is unit-testable without touching the machine.
//
// Mouse actions live in plan.ts, because macOS cannot express them as a command.
import type { OS } from "./os.ts";

const ps = (script: string) => ["powershell", "-NoProfile", "-Command", script];

/** How long focus waits for a window to show up: 20 tries, half a second apart. */
const FOCUS_TRIES = 20, FOCUS_SLEEP = 0.5;

/** AppleScript string literal: backslash and double quote are the only escapes. */
export function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** PowerShell single-quoted string: a quote is doubled. */
export function escapePowerShell(s: string): string {
  return s.replace(/'/g, "''");
}

/**
 * SendKeys reads +^%~(){}[] as syntax, so a literal one has to be braced or it
 * silently becomes a modifier - typing "a+b" would send a shift chord.
 */
export function escapeSendKeys(s: string): string {
  return escapePowerShell(s.replace(/[+^%~(){}\[\]]/g, (c) => `{${c}}`));
}

/**
 * How a screenshot is taken, and crucially where the bytes end up.
 *
 * macOS and Windows write the file themselves; xwd streams a dump to stdout for
 * cu to convert. That difference is in the type rather than in a comment, so a
 * caller cannot forget it - forgetting it once left `settle` running xwd and
 * then looking for a file nobody had written.
 */
export type CapturePlan =
  | { argv: string[]; output: "file" }
  | { argv: string[]; output: "stdout" };

export function captureCmd(os: OS, out: string): CapturePlan {
  switch (os) {
    case "macos": return { argv: ["screencapture", "-x", out], output: "file" };
    // xwd, not import: the runners ship neither, and x11-apps (which carries
    // xwd) is a fraction of imagemagick's size. cu converts the dump itself,
    // which also fixes what import did on a low-colour display - emit a 1-bit
    // PNG that could not be compared against the other platforms'.
    case "linux": return { argv: ["xwd", "-root", "-silent"], output: "stdout" };
    // Bitmap.Save resolves a relative path against the .NET working directory,
    // which is not PowerShell's location - so cu passes an absolute path here.
    case "windows": return { argv: ps(
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
      `$v=[System.Windows.Forms.SystemInformation]::VirtualScreen;` +
      `$b=New-Object System.Drawing.Bitmap($v.Width,$v.Height);` +
      `$g=[System.Drawing.Graphics]::FromImage($b);` +
      `$g.CopyFromScreen($v.Left,$v.Top,0,0,$b.Size);` +
      `$b.Save('${escapePowerShell(out)}',[System.Drawing.Imaging.ImageFormat]::Png);` +
      `$g.Dispose();$b.Dispose()`), output: "file" };
    default: throw new Error(`capture unsupported on ${os}`);
  }
}

export function typeCmd(os: OS, text: string): string[] {
  switch (os) {
    case "macos": return ["osascript", "-e", `tell application "System Events" to keystroke "${escapeAppleScript(text)}"`];
    case "linux": return ["xdotool", "type", "--", text];
    case "windows": return ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${escapeSendKeys(text)}')`);
    default: throw new Error(`type unsupported on ${os}`);
  }
}

export function launchCmd(os: OS, app: string): string[] {
  switch (os) {
    case "macos": return ["open", "-a", app];
    case "linux": return ["sh", "-c", `("${app}" >/dev/null 2>&1 &)`];
    case "windows": return ps(`Start-Process '${escapePowerShell(app)}'`);
    default: throw new Error(`launch unsupported on ${os}`);
  }
}

/**
 * Bring a window to the front so that input has somewhere to land.
 *
 * Without this, `type` is a silent no-op whenever nothing happens to be
 * focused - SendKeys posts to the active window of the caller's input queue,
 * and an X session with no window manager focuses nothing by default.
 */
export function focusCmd(os: OS, name: string): string[] {
  switch (os) {
    case "macos": return ["open", "-a", name];
    // `xdotool search --sync` waits for a matching window forever, which turns
    // a missing app into a hung agent. Poll for a bounded time instead, then
    // fail the same way Windows does: by naming what was not found.
    case "linux": return ["sh", "-c",
      `n=0; while [ $n -lt ${FOCUS_TRIES} ]; do ` +
      `id=$(xdotool search --onlyvisible --name "$1" 2>/dev/null | head -1); ` +
      // windowactivate needs a window manager (_NET_ACTIVE_WINDOW); a bare Xvfb
      // has none, so it is best-effort and windowfocus, which only needs the X
      // server, is what actually has to succeed.
      `if [ -n "$id" ]; then xdotool windowraise "$id" 2>/dev/null; ` +
      `xdotool windowactivate "$id" 2>/dev/null; ` +
      `exec xdotool windowfocus "$id"; fi; ` +
      `n=$((n+1)); sleep ${FOCUS_SLEEP}; done; ` +
      `echo "no window matching '$1'" >&2; exit 1`,
      "sh", name];
    case "windows": return ps(
      `$s=New-Object -ComObject WScript.Shell;` +
      `if(-not $s.AppActivate('${escapePowerShell(name)}')){throw "no window matching '${escapePowerShell(name)}'"}`);
    default: throw new Error(`focus unsupported on ${os}`);
  }
}

// which key a semantic action maps to (select-all/copy/paste) per OS
export function comboKey(os: OS, action: "select-all" | "copy" | "paste"): string {
  const letter = action === "select-all" ? "a" : action === "copy" ? "c" : "v";
  return os === "macos" ? `cmd+${letter}` : `ctrl+${letter}`;
}
