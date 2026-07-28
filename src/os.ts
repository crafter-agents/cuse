// OS detection + the agnostic command mapping. Pure functions, fully testable.
import { escapeAppleScript, escapeSendKeys } from "./commands.ts";

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
  const lower = chord.toLowerCase();
  if (lower.endsWith("+") && lower.length > 1) {
    return { mods: lower.slice(0, -1).split("+").filter(Boolean), base: "+" };
  }
  const parts = lower.split("+");
  return { mods: parts.slice(0, -1), base: parts[parts.length - 1]! };
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
    return { cmd: ["osascript", "-e", `tell application "System Events" to keystroke "${escapeAppleScript(base)}"${usingClause}`] };
  }
  if (os === "linux") {
    const x = chord.replace(/cmd/g, "super");
    return { cmd: ["xdotool", "key", x] };
  }
  if (os === "windows") {
    // SendKeys: ^=ctrl %=alt +=shift; cmd -> ctrl. Prefixes are emitted in a
    // fixed order so the argv is stable to assert against.
    let prefix = "";
    if (has("cmd") || has("ctrl")) prefix += "^";
    if (has("alt")) prefix += "%";
    if (has("shift")) prefix += "+";
    const sk = prefix + escapeSendKeys(base);
    return { cmd: ["powershell", "-NoProfile", "-Command",
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sk}')`] };
  }
  throw new Error(`key unsupported on ${os}`);
}
