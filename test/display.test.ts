import { test, expect, describe } from "bun:test";
import {
  displaysCmd, parseDisplays, frameOrigin, outsideFrame, coverageWarning,
  toScreenPoint, desktopBounds, type Display,
} from "../src/display.ts";
import type { OS } from "../src/os.ts";

const d = (over: Partial<Display>): Display =>
  ({ x: 0, y: 0, width: 1920, height: 1080, primary: false, ...over });

describe("asking each platform what is attached", () => {
  test("every OS has a way", () => {
    for (const os of ["macos", "linux", "windows"] as OS[]) {
      expect(displaysCmd(os).length).toBeGreaterThan(0);
    }
  });
  test("the Linux answer is allowed to be empty", () => {
    // xrandr is not a dependency: the root window spans every monitor there, so
    // a missing list changes nothing about where the frame starts.
    expect(displaysCmd("linux").join(" ")).toContain("|| true");
  });
});

describe("reading the answers", () => {
  test("xrandr's monitor list, primary starred", () => {
    const out = parseDisplays(
      "Monitors: 2\n" +
      " 0: +*HDMI-1 1920/509x1080/286+0+0  HDMI-1\n" +
      " 1: +DP-2 1280/338x1024/270+1920+56  DP-2\n", "linux");
    expect(out).toEqual([
      { x: 0, y: 0, width: 1920, height: 1080, primary: true, name: "HDMI-1" },
      { x: 1920, y: 56, width: 1280, height: 1024, primary: false, name: "DP-2" },
    ]);
  });
  test("a monitor left of the primary keeps its negative origin", () => {
    const out = parseDisplays(
      "Monitors: 2\n" +
      " 0: +*eDP-1 1920/300x1080/190+0+0  eDP-1\n" +
      " 1: +HDMI-1 1600/340x900/190+-1600+0  HDMI-1\n", "linux");
    expect(out[1]).toMatchObject({ x: -1600, y: 0 });
  });
  test("no star means the first monitor is taken as primary", () => {
    const out = parseDisplays(" 0: +screen 1280/339x1024/271+0+0  screen\n", "linux");
    expect(out[0]!.primary).toBe(true);
  });
  test("Windows reports its own rectangles, primary flagged", () => {
    const out = parseDisplays(
      "0\t0\t1920\t1080\t1\t\\\\.\\DISPLAY1\n" +
      "-1600\t-200\t1600\t900\t0\t\\\\.\\DISPLAY2\n", "windows");
    expect(out).toEqual([
      { x: 0, y: 0, width: 1920, height: 1080, primary: true, name: "\\\\.\\DISPLAY1" },
      { x: -1600, y: -200, width: 1600, height: 900, primary: false, name: "\\\\.\\DISPLAY2" },
    ]);
  });

  // The one with a trap in it. NSScreen measures up from the bottom-left of the
  // main screen; clicks are measured down from its top-left. With one screen the
  // flip is the identity, which is why this can only be got wrong invisibly.
  test("macOS is flipped out of NSScreen's bottom-left space", () => {
    const out = parseDisplays("0\t0\t1512\t982\n0\t982\t1920\t1080\n", "macos");
    expect(out[0]).toMatchObject({ x: 0, y: 0, width: 1512, height: 982, primary: true });
    // A screen sitting above the main one: its bottom edge is the main screen's
    // top, so in click space it starts 1080 above the origin.
    expect(out[1]).toMatchObject({ x: 0, y: -1080 });
  });
  test("one macOS screen is unchanged by the flip", () => {
    expect(parseDisplays("0\t0\t1512\t982\n", "macos")[0]).toMatchObject({ x: 0, y: 0 });
  });
  test("junk is skipped rather than parsed into a rectangle", () => {
    expect(parseDisplays("nonsense\n\n", "macos")).toEqual([]);
    expect(parseDisplays("Monitors: 0\n", "linux")).toEqual([]);
  });
});

describe("where the frame starts", () => {
  // The bug this exists for: Windows copies from the virtual screen's own
  // origin, so pixel 0,0 of the file is not screen 0,0.
  test("Windows takes the top-left of the virtual screen", () => {
    const screens = [d({ primary: true }), d({ x: -1600, y: -200, width: 1600, height: 900 })];
    expect(frameOrigin(screens, "windows")).toEqual({ x: -1600, y: -200 });
  });
  test("Linux captures the root window, which starts at the origin", () => {
    expect(frameOrigin([d({}), d({ x: 1920 })], "linux")).toEqual({ x: 0, y: 0 });
  });
  test("macOS captures the main display, which is the origin", () => {
    expect(frameOrigin([d({ primary: true }), d({ x: -1600 })], "macos")).toEqual({ x: 0, y: 0 });
  });
  test("an unknown layout is the single-screen assumption, unchanged", () => {
    expect(frameOrigin([], "windows")).toEqual({ x: 0, y: 0 });
  });
});

describe("frame pixel to screen point", () => {
  test("a Retina frame is halved", () => {
    expect(toScreenPoint(1030, 460, 2, { x: 0, y: 0 })).toEqual({ x: 515, y: 230 });
  });
  test("and shifted by the frame's origin", () => {
    // 40px into a frame that starts at -1600 is not x=40, which is the click
    // that used to land on the wrong monitor.
    expect(toScreenPoint(40, 10, 1, { x: -1600, y: -200 })).toEqual({ x: -1560, y: -190 });
  });
});

describe("what the frame does not show", () => {
  const laptop = d({ primary: true, width: 1512, height: 982 });
  const second = d({ x: 1512, y: 0, width: 1920, height: 1080 });

  test("one screen is never a coverage problem", () => {
    expect(coverageWarning([laptop], { x: 0, y: 0, width: 1512, height: 982 })).toBeUndefined();
  });
  test("a macOS capture of the main display misses the other one", () => {
    const warn = coverageWarning([laptop, second], { x: 0, y: 0, width: 1512, height: 982 })!;
    expect(warn).toContain("2 displays");
    expect(warn).toContain("1920x1080 at 1512,0");
  });
  test("a frame spanning everything says nothing", () => {
    expect(coverageWarning([laptop, second], { x: 0, y: 0, width: 3432, height: 1080 }))
      .toBeUndefined();
  });
  test("a screen above the frame counts as missed too", () => {
    const above = d({ x: 0, y: -1080 });
    expect(outsideFrame([laptop, above], { x: 0, y: 0, width: 1512, height: 982 }))
      .toEqual([above]);
  });
});

describe("the whole desk", () => {
  test("the union of every screen, negative origins included", () => {
    expect(desktopBounds([d({ primary: true }), d({ x: -1600, y: -200, width: 1600, height: 900 })]))
      .toEqual({ x: -1600, y: -200, width: 3520, height: 1280 });
  });
  test("nothing attached is not a rectangle", () => {
    expect(desktopBounds([])).toBeNull();
  });
});
