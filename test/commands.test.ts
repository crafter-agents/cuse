import { test, expect, describe } from "bun:test";
import { detectOS, chordToOS } from "../src/os.ts";
import { captureCmd, typeCmd, launchCmd, moveCmd, scrollCmd, comboKey } from "../src/commands.ts";
import { preflight } from "../src/preflight.ts";
import type { OS } from "../src/os.ts";

const OSES: OS[] = ["macos", "linux", "windows"];

describe("detectOS", () => {
  test("maps known platforms", () => {
    expect(detectOS("darwin")).toBe("macos");
    expect(detectOS("linux")).toBe("linux");
    expect(detectOS("win32")).toBe("windows");
  });
  test("unknown platform -> unknown", () => {
    expect(detectOS("aix" as NodeJS.Platform)).toBe("unknown");
  });
});

describe("capture", () => {
  test("macOS screencapture", () => expect(captureCmd("macos", "o.png")).toEqual(["screencapture", "-x", "o.png"]));
  test("linux import", () => expect(captureCmd("linux", "o.png")).toEqual(["import", "-window", "root", "o.png"]));
  test("windows GDI CopyFromScreen + path", () => {
    const c = captureCmd("windows", "o.png").join(" ");
    expect(c).toContain("CopyFromScreen");
    expect(c).toContain("o.png");
  });
  test("unknown OS throws (no silent wrong behavior)", () => expect(() => captureCmd("unknown", "o.png")).toThrow("unsupported"));
});

describe("type", () => {
  test.each(OSES)("%s produces a command containing the text", (os) => {
    expect(typeCmd(os, "hello").join(" ")).toContain("hello");
  });
});

describe("chordToOS — cross-platform key mapping", () => {
  test("cmd+a on macOS uses command down", () => {
    expect(chordToOS("macos", "cmd+a").cmd.join(" ")).toContain("command down");
  });
  test("cmd+a on windows maps to ^a (ctrl)", () => {
    expect(chordToOS("windows", "cmd+a").cmd.join(" ")).toContain("^a");
  });
  test("cmd on linux becomes super", () => {
    expect(chordToOS("linux", "cmd+a").cmd.join(" ")).toContain("super");
  });
  test("multi-modifier ctrl+shift+t on macOS", () => {
    const s = chordToOS("macos", "ctrl+shift+t").cmd.join(" ");
    expect(s).toContain("control down");
    expect(s).toContain("shift down");
  });
});

describe("move / scroll / combos", () => {
  test.each(OSES)("move on %s includes coords", (os) => {
    expect(moveCmd(os, 100, 200).join(" ")).toMatch(/100.*200|200.*100/);
  });
  test("scroll down 3 on linux -> 3 xdotool clicks", () => {
    const cmds = scrollCmd("linux", "down", 3);
    expect(cmds.length).toBe(3);
    expect(cmds[0]).toEqual(["xdotool", "click", "5"]);
  });
  test("select-all combo is cmd+a on mac, ctrl+a elsewhere", () => {
    expect(comboKey("macos", "select-all")).toBe("cmd+a");
    expect(comboKey("windows", "select-all")).toBe("ctrl+a");
    expect(comboKey("linux", "copy")).toBe("ctrl+c");
  });
});

describe("preflight", () => {
  const withEnv = (env: Record<string, string | undefined>, present: string[] = []) => ({
    env,
    has: (t: string) => present.includes(t),
  });
  const ALL = ["import", "xdotool"];

  test("linux capture without DISPLAY explains Xvfb", () => {
    const r = preflight("linux", "capture", withEnv({}, ALL));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("DISPLAY is unset");
  });
  test("linux capture with DISPLAY and imagemagick passes", () => {
    expect(preflight("linux", "capture", withEnv({ DISPLAY: ":99" }, ALL)).ok).toBe(true);
  });
  test("linux capture names the missing tool and its install", () => {
    const r = preflight("linux", "capture", withEnv({ DISPLAY: ":99" }, ["xdotool"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("imagemagick");
  });
  test("linux input actions need xdotool", () => {
    const r = preflight("linux", "type", withEnv({ DISPLAY: ":99" }, ["import"]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("xdotool");
  });
  test("macOS and Windows need no display bootstrap", () => {
    for (const os of ["macos", "windows"] as OS[]) {
      expect(preflight(os, "capture", withEnv({})).ok).toBe(true);
      expect(preflight(os, "type", withEnv({})).ok).toBe(true);
    }
  });
  test("unknown platform is refused, not attempted", () => {
    expect(preflight("unknown", "capture", withEnv({}, ALL)).ok).toBe(false);
  });
  test("DISPLAY alone is not enough on linux — tools are checked first", () => {
    const r = preflight("linux", "capture", withEnv({ DISPLAY: ":99" }, []));
    expect(r.ok).toBe(false);
  });
});
