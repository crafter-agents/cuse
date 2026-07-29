import { test, expect, describe } from "bun:test";
import { runningAppsCmd, parseApps, pickApp, describeApps } from "../src/apps.ts";

// Trimmed from a real `ps -Ax -o pid=,command=` on this machine, helpers and all.
const PS = [
  "    1 /sbin/launchd",
  "  108 /Applications/Dia.app/Contents/MacOS/Dia",
  "  180 /Applications/Dia.app/Contents/Frameworks/ArcCore.framework/Helpers/Browser Helper.app/Contents/MacOS/Browser Helper",
  " 1130 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder",
  " 2201 /Applications/Ghostty.app/Contents/MacOS/ghostty --title=x",
  "  442 /usr/libexec/secinitd",
].join("\n");

describe("finding the process behind a name", () => {
  test("asks ps for every process and what started it", () => {
    expect(runningAppsCmd()).toEqual(["ps", "-Ax", "-o", "pid=,command="]);
  });
  test("only application bundles are candidates; daemons have no window", () => {
    expect(parseApps(PS).map((a) => a.bundle))
      .toEqual(["Dia", "Browser Helper", "Finder", "Ghostty"]);
  });
  test("the bundle names the process, not the executable inside it", () => {
    // Ghostty's binary is lowercase `ghostty`; nobody types that.
    expect(parseApps(PS).find((a) => a.pid === 2201)!.bundle).toBe("Ghostty");
  });
  test("case-insensitive, like every other name match in cuse", () => {
    expect(pickApp(parseApps(PS), "finder")!.pid).toBe(1130);
  });
  test("nothing matching is null, not the first thing running", () => {
    expect(pickApp(parseApps(PS), "TextEdit")).toBeNull();
    expect(pickApp(parseApps(PS), "")).toBeNull();
  });

  // The failure this ordering exists for: a helper bundle whose name contains
  // the app's would otherwise answer, and its tree belongs to a renderer with
  // no window in it.
  test("the app beats a helper nested inside it", () => {
    const ps = [
      " 300 /Applications/Zed.app/Contents/Frameworks/Zed Helper.app/Contents/MacOS/Zed Helper",
      " 301 /Applications/Zed.app/Contents/MacOS/Zed",
    ].join("\n");
    expect(pickApp(parseApps(ps), "Zed")!.pid).toBe(301);
  });
  test("and an exact name beats a longer one containing it", () => {
    const ps = [
      " 400 /Applications/Notes Helper.app/Contents/MacOS/Notes Helper",
      " 401 /Applications/Notes.app/Contents/MacOS/Notes",
    ].join("\n");
    expect(pickApp(parseApps(ps), "Notes")!.pid).toBe(401);
  });
  test("a partial name still works when it is unambiguous", () => {
    expect(pickApp(parseApps(PS), "ghost")!.pid).toBe(2201);
  });
});

describe("saying what is there instead", () => {
  test("names the applications, without repeating one", () => {
    const said = describeApps(parseApps(`${PS}\n 9999 /Applications/Dia.app/Contents/MacOS/Dia`));
    expect(said).toContain("Finder");
    expect(said.match(/Dia/g)).toHaveLength(1);
  });
  test("an empty machine says so rather than printing nothing", () => {
    expect(describeApps([])).toBe("no applications are running");
  });
});
