import { test, expect, describe } from "bun:test";
import { listWindowsCmd, parseWindows, pickWindow, pointIn,
         frontmostCmd, parseFrontmost, frontmostMatches } from "../src/window.ts";
import type { OS } from "../src/os.ts";

describe("listing windows", () => {
  test("every supported OS has a way to ask", () => {
    for (const os of ["macos", "linux", "windows"] as OS[]) {
      expect(listWindowsCmd(os).length).toBeGreaterThan(0);
    }
  });
  test("macOS asks System Events for position and size", () => {
    const c = listWindowsCmd("macos").join(" ");
    expect(c).toContain("System Events");
    expect(c).toContain("position of w");
    expect(c).toContain("size of w");
  });
  test("windows uses UI Automation, the only API with a bounding rectangle", () => {
    const c = listWindowsCmd("windows").join(" ");
    expect(c).toContain("UIAutomationClient");
    expect(c).toContain("BoundingRectangle");
  });
  test("linux asks xdotool per window, so no window manager is required", () => {
    const c = listWindowsCmd("linux").join(" ");
    expect(c).toContain("getwindowgeometry");
    expect(c).toContain("--onlyvisible");
  });
});

describe("parsing what they print", () => {
  test("reads the linux form: title then geometry", () => {
    expect(parseWindows("CU_TARGET\t0\t0\t800\t600\n")).toEqual([
      { title: "CU_TARGET", x: 0, y: 0, width: 800, height: 600 },
    ]);
  });
  test("reads the macOS form, preferring the window name over the process", () => {
    expect(parseWindows("TextEdit\ttarget.txt\t120\t80\t700\t500\n")).toEqual([
      { title: "target.txt", x: 120, y: 80, width: 700, height: 500 },
    ]);
  });
  test("falls back to the process name when the window is untitled", () => {
    expect(parseWindows("TextEdit\t\t120\t80\t700\t500\n")[0]!.title).toBe("TextEdit");
  });
  test("skips noise instead of inventing windows", () => {
    const text = "\n" + "not a window line\n" + "Bad\tx\ty\tw\th\n" + "Good\t1\t2\t3\t4\n";
    expect(parseWindows(text)).toEqual([{ title: "Good", x: 1, y: 2, width: 3, height: 4 }]);
  });
  test("drops zero-sized windows, which every desktop has plenty of", () => {
    expect(parseWindows("Hidden\t0\t0\t0\t0\nReal\t5\t5\t10\t10\n")).toHaveLength(1);
  });
});

describe("aiming at a window", () => {
  const wins = [
    { title: "Untitled - CU_TARGET", x: 100, y: 50, width: 400, height: 200 },
    { title: "Finder", x: 0, y: 0, width: 800, height: 600 },
  ];
  test("finds a window by part of its title, case-insensitively", () => {
    expect(pickWindow(wins, "cu_target")!.width).toBe(400);
    expect(pickWindow(wins, "finder")!.title).toBe("Finder");
  });
  test("returns null for a window that is not there", () => {
    expect(pickWindow(wins, "Photoshop")).toBeNull();
  });
  test("the centre of a window is where a click should land by default", () => {
    expect(pointIn(wins[0]!)).toEqual({ x: 300, y: 150 });
  });
  test("fractions, not pixels, so the aim survives a moved or resized window", () => {
    expect(pointIn(wins[0]!, 0, 0)).toEqual({ x: 100, y: 50 });
    expect(pointIn(wins[0]!, 1, 1)).toEqual({ x: 500, y: 250 });
    expect(pointIn({ ...wins[0]!, x: 300, width: 800 }, 0.5, 0.5)).toEqual({ x: 700, y: 150 });
  });
});

describe("who has the keyboard", () => {
  test("every OS can be asked", () => {
    for (const os of ["macos", "linux", "windows"] as OS[]) {
      expect(frontmostCmd(os).length).toBeGreaterThan(0);
    }
  });
  test("the answer is flattened to one line, process and window together", () => {
    expect(parseFrontmost("TextEdit\ttarget.txt\n")).toBe("TextEdit target.txt");
    expect(parseFrontmost("  CU_TARGET \n")).toBe("CU_TARGET");
  });
  test("a match is a case-insensitive substring, like focus", () => {
    expect(frontmostMatches("TextEdit target.txt", "textedit")).toBe(true);
    expect(frontmostMatches("TextEdit target.txt", "target")).toBe(true);
  });
  test("the dialog that actually stole focus in CI would be caught", () => {
    // "bash is requesting to bypass the system private window picker"
    expect(frontmostMatches("universalAccessAuthWarn", "TextEdit")).toBe(false);
  });
  test("an unreadable answer never blocks: unknown is not a mismatch", () => {
    expect(frontmostMatches("", "TextEdit")).toBe(true);
  });
});
