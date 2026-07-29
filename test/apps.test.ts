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
  test("application bundles come out named by their bundle", () => {
    expect(parseApps(PS).filter((a) => a.bundled).map((a) => a.bundle))
      .toEqual(["Dia", "Browser Helper", "Finder", "Ghostty"]);
  });
  // A window can belong to a process with no bundle around it. `osascript`
  // puts a modal dialog on screen from /usr/bin/osascript, and dropping it
  // meant cuse said "no running application matching 'osascript'" with the
  // dialog in front of everything.
  test("a plain executable is a candidate too, under its own name", () => {
    const apps = parseApps(`${PS}\n 7000 /usr/bin/osascript -e display dialog "hi"`);
    const osa = apps.find((a) => a.bundle === "osascript")!;
    expect(osa).toMatchObject({ pid: 7000, bundled: false });
    expect(pickApp(apps, "osascript")!.pid).toBe(7000);
  });
  test("arguments are not part of the name", () => {
    expect(parseApps(" 7000 /usr/bin/osascript -e foo").map((a) => a.bundle)).toEqual(["osascript"]);
  });
  // `ps` prints argv[0] as the caller passed it, so a command found on PATH has
  // no directory in front of it. Requiring one is what hid the dialog: the real
  // line is `34282 osascript -e delay 8`.
  test("an executable found on PATH has no leading slash, and still counts", () => {
    const apps = parseApps(" 34282 osascript -e delay 8");
    expect(apps).toEqual([{ pid: 34282, bundle: "osascript",
                            path: "osascript -e delay 8", bundled: false }]);
  });
  test("kernel threads print in parentheses and own no windows", () => {
    expect(parseApps(" 3 (fseventsd)\n 4 (kernel_task)")).toEqual([]);
  });
  // The unbundled list is mostly daemons; a partial word must not pull one of
  // those ahead of the application the caller can see.
  test("a real application beats a plain executable of the same name", () => {
    const ps = [
      " 500 /usr/local/bin/code",
      " 501 /Applications/Code.app/Contents/MacOS/Code",
    ].join("\n");
    expect(pickApp(parseApps(ps), "code")!.pid).toBe(501);
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
  test("suggests applications only: a hundred daemons buries the six real names", () => {
    const said = describeApps(parseApps(`${PS}\n 7000 /usr/bin/osascript`));
    expect(said).not.toContain("osascript");
    expect(said).toContain("Ghostty");
  });
  test("names the applications, without repeating one", () => {
    const said = describeApps(parseApps(`${PS}\n 9999 /Applications/Dia.app/Contents/MacOS/Dia`));
    expect(said).toContain("Finder");
    expect(said.match(/Dia/g)).toHaveLength(1);
  });
  test("an empty machine says so rather than printing nothing", () => {
    expect(describeApps([])).toBe("no applications are running");
  });
});
