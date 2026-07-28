// OS detection + the agnostic command mapping. Pure functions, fully testable.
import { escapeAppleScript, escapeSendKeys } from "./commands.ts";
import { canonicalKeyName, macKeyCode, windowsKey, linuxKey } from "./keys.ts";

export type OS = "macos" | "linux" | "windows" | "unknown";

export function detectOS(platform: NodeJS.Platform = process.platform): OS {
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  if (platform === "win32") return "windows";
  return "unknown";
}

/**
 * Split a chord into modifiers and the key they apply to.
 *
 * Splitting on "+" naively loses the case where "+" is itself the key, since
 * "ctrl++" then ends in an empty segment - so a trailing separator is read as
 * the key rather than as a delimiter.
 */
export function parseChord(chord: string): { mods: string[]; base: string } {
  if (chord.endsWith("+") && chord.length > 1) {
    return { mods: chord.slice(0, -1).toLowerCase().split("+").filter(Boolean), base: "+" };
  }
  const parts = chord.split("+");
  // Modifiers are lowercased; the key is not. Lowercasing everything turned F4
  // into the letters f and 4 on Windows and into an unknown keysym on Linux.
  return {
    mods: parts.slice(0, -1).map((m) => m.toLowerCase()),
    base: parts[parts.length - 1]!,
  };
}

/** How a modifier chord maps to each OS input plane. Pure. */
export function chordToOS(os: OS, chord: string): { cmd: string[]; note?: string } {
  const { mods, base } = parseChord(chord);
  const has = (m: string) => mods.some((x) => x === m || (m === "cmd" && x === "meta"));

  if (os === "macos") {
    const using: string[] = [];
    if (has("cmd")) using.push("command down");
    if (has("ctrl")) using.push("control down");
    if (has("shift")) using.push("shift down");
    if (has("alt") || has("opt")) using.push("option down");
    const usingClause = using.length ? ` using {${using.join(", ")}}` : "";
    // System Events cannot name Escape or the function keys; they go by code.
    const named = canonicalKeyName(base);
    const code = named ? macKeyCode(named) : undefined;
    if (code !== undefined) {
      return { cmd: ["osascript", "-e",
        `tell application "System Events" to key code ${code}${usingClause}`] };
    }
    return { cmd: ["osascript", "-e", `tell application "System Events" to keystroke "${escapeAppleScript(base)}"${usingClause}`] };
  }
  if (os === "linux") {
    // xdotool wants keysyms, and their capitalisation matters.
    const named = canonicalKeyName(base);
    const key = named ? linuxKey(named) : base;
    const prefix = mods.map((m) => (m === "cmd" || m === "meta" ? "super" : m));
    return { cmd: ["xdotool", "key", [...prefix, key].join("+")] };
  }
  if (os === "windows") {
    // SendKeys: ^=ctrl %=alt +=shift; cmd -> ctrl. Prefixes are emitted in a
    // fixed order so the argv is stable to assert against.
    let prefix = "";
    if (has("cmd") || has("ctrl")) prefix += "^";
    if (has("alt")) prefix += "%";
    if (has("shift")) prefix += "+";
    // A named key has to be braced or SendKeys types its letters instead.
    const named = canonicalKeyName(base);
    const sk = prefix + (named ? windowsKey(named) : escapeSendKeys(base));
    return { cmd: ["powershell", "-NoProfile", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sk}')`] };
  }
  throw new Error(`key unsupported on ${os}`);
}
