import { test, expect, describe } from "bun:test";
import { chordToOS, parseChord } from "../src/os.ts";
import { canonicalKeyName, macKeyCode, windowsKey, linuxKey } from "../src/keys.ts";

const sent = (os: "macos" | "linux" | "windows", chord: string) =>
  chordToOS(os, chord).cmd.at(-1)!;

describe("named keys versus characters", () => {
  test("a key with a name is recognised however it was spelled", () => {
    expect(canonicalKeyName("Escape")).toBe("escape");
    expect(canonicalKeyName("esc")).toBe("escape");
    expect(canonicalKeyName("ENTER")).toBe("return");
    expect(canonicalKeyName("F4")).toBe("f4");
    expect(canonicalKeyName("f12")).toBe("f12");
    expect(canonicalKeyName("PgUp")).toBe("pageup");
  });
  test("a letter is not a named key", () => {
    expect(canonicalKeyName("s")).toBeNull();
    expect(canonicalKeyName("+")).toBeNull();
    expect(canonicalKeyName("f25")).toBeNull();
  });
});

describe("the case that broke all three", () => {
  // alt+F4 sent as "%F4" types the letters f and 4. An app chooser sat through
  // five attempts to close it because of exactly this.
  test("windows braces it", () => {
    expect(sent("windows", "alt+F4")).toContain("'%{F4}'");
  });
  test("macOS uses the virtual key code, since System Events cannot name it", () => {
    expect(sent("macos", "alt+F4")).toContain("key code 118 using {option down}");
  });
  test("linux keeps the keysym's capitalisation", () => {
    expect(sent("linux", "alt+F4")).toBe("alt+F4");
    // Lowercased, xdotool does not know what this is.
    expect(sent("linux", "F4")).toBe("F4");
  });
});

describe("the other named keys", () => {
  test("Escape", () => {
    expect(sent("windows", "Escape")).toContain("{ESC}");
    expect(sent("macos", "Escape")).toContain("key code 53");
    expect(sent("linux", "Escape")).toBe("Escape");
  });
  test("Return, however it is spelled", () => {
    for (const spelling of ["Return", "Enter", "enter"]) {
      expect(sent("windows", spelling)).toContain("{ENTER}");
      expect(sent("macos", spelling)).toContain("key code 36");
      expect(sent("linux", spelling)).toBe("Return");
    }
  });
  test("page keys use the spelling each platform actually accepts", () => {
    expect(sent("linux", "pageup")).toBe("Prior");     // not "PageUp"
    expect(sent("windows", "pagedown")).toContain("{PGDN}");
    expect(sent("macos", "pagedown")).toContain("key code 121");
  });
  test("a modifier still applies to a named key", () => {
    expect(sent("windows", "ctrl+Home")).toContain("'^{HOME}'");
    expect(sent("macos", "ctrl+Home")).toContain("key code 115 using {control down}");
    expect(sent("linux", "ctrl+Home")).toBe("ctrl+Home");
  });
});

describe("letters are untouched by any of this", () => {
  test("the chords that always worked still do", () => {
    expect(sent("windows", "ctrl+s")).toContain("'^s'");
    expect(sent("macos", "cmd+shift+a")).toContain('keystroke "a" using {command down, shift down}');
    expect(sent("linux", "cmd+a")).toBe("super+a");
  });
  test("a modifier is matched case-insensitively, the key is not lowercased", () => {
    expect(parseChord("CTRL+F4")).toEqual({ mods: ["ctrl"], base: "F4" });
    expect(parseChord("ctrl++")).toEqual({ mods: ["ctrl"], base: "+" });
  });
  test("the per-platform tables agree on what they cover", () => {
    for (const name of ["escape", "return", "f4", "home"]) {
      expect(macKeyCode(name)).toBeGreaterThan(0);
      expect(windowsKey(name)).toMatch(/^[{ ]/);
      expect(linuxKey(name)).toBeTruthy();
    }
  });
});
