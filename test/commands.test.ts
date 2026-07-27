import { test, expect, describe } from "bun:test";
import { detectOS, chordToOS } from "../src/os.ts";
import {
  captureCmd, typeCmd, launchCmd, focusCmd, comboKey,
  escapeAppleScript, escapePowerShell, escapeSendKeys,
} from "../src/commands.ts";
import { movePlan, clickPlan, scrollPlan } from "../src/plan.ts";
import { preflight, frameWarning, requiredTool } from "../src/preflight.ts";
import { parseMacLockState, parseWindowsLockState, isSessionLocked, LOCK_QUERY, LOCKED_REASON } from "../src/session.ts";
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
  test("linux import grabs the root window", () => {
    const c = captureCmd("linux", "o.png");
    expect(c.slice(0, 4)).toEqual(["import", "-window", "root", "-depth"]);
    expect(c.at(-1)).toBe("o.png");
  });
  test("windows GDI CopyFromScreen + path", () => {
    const c = captureCmd("windows", "C:\\tmp\\o.png").join(" ");
    expect(c).toContain("CopyFromScreen");
    expect(c).toContain("C:\\tmp\\o.png");
  });
  test("windows names the PNG encoder rather than guessing from the extension", () => {
    expect(captureCmd("windows", "o.png").join(" ")).toContain("ImageFormat]::Png");
  });
  test("windows releases the GDI objects", () => {
    const c = captureCmd("windows", "o.png").join(" ");
    expect(c).toContain("$g.Dispose()");
    expect(c).toContain("$b.Dispose()");
  });
  test("every supported OS builds a command", () => {
    for (const os of OSES) expect(captureCmd(os, "o.png").length).toBeGreaterThan(0);
  });
});

describe("escaping", () => {
  test("AppleScript escapes quote and backslash", () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAppleScript("a\\b")).toBe("a\\\\b");
  });
  test("PowerShell doubles a single quote", () => {
    expect(escapePowerShell("it's")).toBe("it''s");
  });
  test("SendKeys braces its syntax characters", () => {
    // Unbraced, "a+b" would send shift+b instead of the literal text.
    expect(escapeSendKeys("a+b")).toBe("a{+}b");
    expect(escapeSendKeys("100%")).toBe("100{%}");
    expect(escapeSendKeys("f(x)[1]")).toBe("f{(}x{)}{[}1{]}");
  });
  test("a quote in typed text does not break out of the AppleScript literal", () => {
    const c = typeCmd("macos", 'he said "no"').join(" ");
    expect(c).toContain('\\"no\\"');
  });
  test("a quote in typed text does not break out of the PowerShell literal", () => {
    expect(typeCmd("windows", "it's").join(" ")).toContain("it''s");
  });
  test("a modifier character used as a key is escaped too", () => {
    expect(chordToOS("windows", "ctrl++").cmd.join(" ")).toContain("^{+}");
  });
});

describe("type", () => {
  test("linux passes text after -- so a leading dash is not read as a flag", () => {
    expect(typeCmd("linux", "--help")).toEqual(["xdotool", "type", "--", "--help"]);
  });
  test("every supported OS builds a command", () => {
    for (const os of OSES) expect(typeCmd(os, "hi").length).toBeGreaterThan(0);
  });
});

describe("launch", () => {
  test("macOS uses open -a, which needs no automation permission", () => {
    expect(launchCmd("macos", "TextEdit")).toEqual(["open", "-a", "TextEdit"]);
  });
  test("windows quotes the app name", () => {
    expect(launchCmd("windows", "note'pad").join(" ")).toContain("note''pad");
  });
});

describe("chords", () => {
  test("macOS builds a using clause per modifier", () => {
    const c = chordToOS("macos", "cmd+shift+a").cmd.join(" ");
    expect(c).toContain("command down");
    expect(c).toContain("shift down");
  });
  test("linux rewrites cmd to super", () => {
    expect(chordToOS("linux", "cmd+a").cmd).toEqual(["xdotool", "key", "super+a"]);
  });
  test("windows uses SendKeys modifier prefixes", () => {
    expect(chordToOS("windows", "ctrl+a").cmd.join(" ")).toContain("^a");
    expect(chordToOS("windows", "alt+shift+a").cmd.join(" ")).toContain("%+a");
  });
  test("combo keys follow the platform convention", () => {
    expect(comboKey("macos", "copy")).toBe("cmd+c");
    expect(comboKey("linux", "copy")).toBe("ctrl+c");
    expect(comboKey("windows", "paste")).toBe("ctrl+v");
    expect(comboKey("macos", "select-all")).toBe("cmd+a");
  });
});

describe("mouse plans", () => {
  test("macOS moves natively, because System Events has no mouse API", () => {
    expect(movePlan("macos", 10, 20)).toEqual({ kind: "native", op: "warp", x: 10, y: 20 });
  });
  test("linux and windows move through a command", () => {
    expect(movePlan("linux", 10, 20)).toEqual({ kind: "exec", argv: ["xdotool", "mousemove", "10", "20"] });
    const w = movePlan("windows", 10, 20);
    expect(w.kind).toBe("exec");
    if (w.kind === "exec") expect(w.argv.join(" ")).toContain("Point(10,20)");
  });
  test("click without coordinates does not invent a position", () => {
    expect(clickPlan("macos", 1)).toEqual({ kind: "native", op: "click", x: undefined, y: undefined, count: 1 });
    const l = clickPlan("linux", 1);
    if (l.kind === "exec-many") expect(l.argvs).toEqual([["xdotool", "click", "--repeat", "1", "1"]]);
  });
  test("click with coordinates moves first on linux", () => {
    const l = clickPlan("linux", 1, 5, 6);
    if (l.kind === "exec-many") expect(l.argvs[0]).toEqual(["xdotool", "mousemove", "5", "6"]);
  });
  test("dblclick is a click count, not two unrelated clicks", () => {
    expect(clickPlan("macos", 2)).toMatchObject({ op: "click", count: 2 });
    const l = clickPlan("linux", 2);
    if (l.kind === "exec-many") expect(l.argvs.at(-1)).toEqual(["xdotool", "click", "--repeat", "2", "1"]);
  });
  test("scroll direction maps to sign on macOS and to buttons on linux", () => {
    expect(scrollPlan("macos", "up", 3)).toEqual({ kind: "native", op: "scroll", lines: 3 });
    expect(scrollPlan("macos", "down", 3)).toEqual({ kind: "native", op: "scroll", lines: -3 });
    const up = scrollPlan("linux", "up", 2), down = scrollPlan("linux", "down", 2);
    if (up.kind === "exec-many") expect(up.argvs).toEqual([["xdotool", "click", "4"], ["xdotool", "click", "4"]]);
    if (down.kind === "exec-many") expect(down.argvs[0]).toEqual(["xdotool", "click", "5"]);
  });
  test("every supported OS has a plan for every mouse action", () => {
    for (const os of OSES) {
      expect(movePlan(os, 1, 1)).toBeDefined();
      expect(clickPlan(os, 1, 1, 1)).toBeDefined();
      expect(scrollPlan(os, "down", 1)).toBeDefined();
    }
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
  test("every linux input action needs xdotool, the mouse ones included", () => {
    for (const a of ["type", "key", "click", "dblclick", "move", "scroll", "copy"]) {
      const r = preflight("linux", a, withEnv({ DISPLAY: ":99" }, ["import"]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("xdotool");
    }
  });
  test("macOS needs nothing installed, mouse included", () => {
    for (const a of ["capture", "type", "click", "move", "scroll"]) {
      expect(requiredTool("macos", a)).toBeNull();
      expect(preflight("macos", a, withEnv({})).ok).toBe(true);
    }
  });
  test("windows needs nothing installed", () => {
    for (const a of ["capture", "type", "click"]) expect(preflight("windows", a, withEnv({})).ok).toBe(true);
  });
  test("unknown platform is refused, not attempted", () => {
    expect(preflight("unknown", "capture", withEnv({}, ALL)).ok).toBe(false);
  });
});

describe("frameWarning", () => {
  test("an exactly uniform frame is reported as blank", () => {
    expect(frameWarning({ bytes: 295, width: 1280, height: 1024, uniform: true })).toContain("blank");
  });
  test("a decoded frame with content is never warned about, however small", () => {
    expect(frameWarning({ bytes: 295, width: 1280, height: 1024, uniform: false })).toBeUndefined();
  });
  test("without a decode it falls back to bytes per pixel (values observed in CI)", () => {
    expect(frameWarning({ bytes: 295, width: 1280, height: 1024 })).toContain("blank");
    expect(frameWarning({ bytes: 80431, width: 1024, height: 768 })).toBeUndefined();   // macos runner
    expect(frameWarning({ bytes: 267703, width: 1024, height: 768 })).toBeUndefined();  // windows runner
  });
  test("the warning says why it matters to an agent", () => {
    expect(frameWarning({ bytes: 1, width: 10, height: 10, uniform: true })).toContain("no window");
  });
  test("no dimensions -> no claim", () => {
    expect(frameWarning({ bytes: 295, width: 0, height: 0 })).toBeUndefined();
  });
});

describe("locked session", () => {
  const LOCKED = `<key>CGSSessionScreenIsLocked</key>\n<true/>`;
  const UNLOCKED = `<key>CGSSessionScreenIsLocked</key>\n<false/>`;

  test("reads the macOS lock flag out of the ioreg plist", () => {
    expect(parseMacLockState(LOCKED)).toBe(true);
    expect(parseMacLockState(UNLOCKED)).toBe(false);
  });
  test("an absent key is unknown, not locked - so it never blocks by accident", () => {
    expect(parseMacLockState("<key>Something</key><true/>")).toBeNull();
  });
  test("windows is locked while LogonUI is running", () => {
    expect(parseWindowsLockState("LogonUI.exe   1234 Console")).toBe(true);
    expect(parseWindowsLockState("INFO: No tasks are running.")).toBe(false);
  });
  test("an unreadable probe returns unknown rather than a guess", async () => {
    expect(await isSessionLocked({ os: "macos", read: async () => null })).toBeNull();
  });
  test("locked macOS session is reported as locked", async () => {
    expect(await isSessionLocked({ os: "macos", read: async () => LOCKED })).toBe(true);
  });
  test("linux has no dependable lock query, so it is never blocked", async () => {
    expect(LOCK_QUERY.linux).toBeUndefined();
    expect(await isSessionLocked({ os: "linux", read: async () => "anything" })).toBeNull();
  });
  test("the refusal tells the user how to override it", () => {
    expect(LOCKED_REASON).toContain("--force");
  });
});

describe("focus", () => {
  test("macOS reuses open -a, which both launches and fronts the app", () => {
    expect(focusCmd("macos", "TextEdit")).toEqual(["open", "-a", "TextEdit"]);
  });
  test("linux finds the window, then raises, activates and focuses it", () => {
    const c = focusCmd("linux", "xterm").join(" ");
    expect(c).toContain("xdotool search --onlyvisible --name");
    expect(c).toContain("windowraise");
    expect(c).toContain("windowfocus");
  });
  test("linux tolerates a missing window manager", () => {
    // windowactivate needs _NET_ACTIVE_WINDOW, which a bare Xvfb does not have,
    // so only windowfocus - which the X server alone can do - may be required.
    const c = focusCmd("linux", "xterm").join(" ");
    expect(c).toContain("windowactivate \"$id\" 2>/dev/null");
    expect(c).toContain("exec xdotool windowfocus");
  });
  test("windows raises a real error when no window matches, rather than typing into the void", () => {
    const c = focusCmd("windows", "Notepad").join(" ");
    expect(c).toContain("AppActivate");
    expect(c).toContain("throw");
  });
  test("linux focus needs xdotool like the other input actions", () => {
    expect(requiredTool("linux", "focus")).toMatchObject({ tool: "xdotool" });
  });
  test("linux capture asks for 8-bit truecolour so frames compare across platforms", () => {
    const c = captureCmd("linux", "o.png");
    expect(c).toContain("-depth");
    expect(c).toContain("png:color-type=2");
  });
});

describe("focus does not hang", () => {
  test("linux polls for a bounded time instead of waiting forever", () => {
    const c = focusCmd("linux", "xterm").join(" ");
    // `--sync` is what blocks indefinitely when the window never appears.
    expect(c).not.toContain("--sync");
    expect(c).toContain("while");
  });
  test("linux passes the name as an argument, not spliced into the script", () => {
    // Splicing would let a window name like `"; rm -rf /` run as shell.
    const c = focusCmd("linux", 'evil"; touch /tmp/pwned #');
    expect(c.at(-1)).toBe('evil"; touch /tmp/pwned #');
    expect(c[2]).not.toContain("pwned");
  });
  test("linux and windows both fail by naming the window that is missing", () => {
    expect(focusCmd("linux", "xterm").join(" ")).toContain("no window matching");
    expect(focusCmd("windows", "CU_TARGET").join(" ")).toContain("no window matching");
  });
});
