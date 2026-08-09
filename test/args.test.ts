import { test, expect, describe } from "bun:test";
import { tokenize, parseArgs, withSession } from "../src/args.ts";

describe("splitting a line", () => {
  test("plain words", () => expect(tokenize("focus TextEdit")).toEqual(["focus", "TextEdit"]));
  test("a quoted argument stays one argument", () => {
    expect(tokenize('type "hello world"')).toEqual(["type", "hello world"]);
    expect(tokenize("type 'hello world'")).toEqual(["type", "hello world"]);
  });
  test("an empty quoted argument is still an argument", () => {
    expect(tokenize('type ""')).toEqual(["type", ""]);
  });
  test("quotes inside a flag survive", () => {
    expect(tokenize('click --element="Save As..."')).toEqual(["click", "--element=Save As..."]);
  });
  test("a Windows path keeps its backslashes", () => {
    expect(tokenize("capture C:\\tmp\\out.png")).toEqual(["capture", "C:\\tmp\\out.png"]);
  });
  test("runs of whitespace collapse, tabs included", () => {
    expect(tokenize("  focus \t  TextEdit  ")).toEqual(["focus", "TextEdit"]);
  });
  test("an empty line is no tokens, not one empty one", () => {
    expect(tokenize("   ")).toEqual([]);
  });
});

describe("reading the options", () => {
  test("action and positional arguments", () => {
    const p = parseArgs(["crop", "in.png", "1", "2", "3", "4", "out.png"]);
    expect(p.action).toBe("crop");
    expect(p.args).toEqual(["in.png", "1", "2", "3", "4", "out.png"]);
  });
  test("flags are not positional arguments", () => {
    expect(parseArgs(["click", "--element=Save", "--json"]).args).toEqual([]);
  });
  test("a value containing = survives, because names do", () => {
    expect(parseArgs(["click", "--element=a=b"]).opts.element).toBe("a=b");
  });
  test("numbers are numbers", () => {
    const o = parseArgs(["find", "n.png", "--min-score=0.75", "--timeout=4000"]).opts;
    expect(o.minScore).toBe(0.75);
    expect(o.timeoutMs).toBe(4000);
  });
  test("a point is a pair", () => {
    expect(parseArgs(["click", "--at=0.25,0.75"]).opts.at).toEqual([0.25, 0.75]);
  });
  test("a click button is parsed as an action option", () => {
    expect(parseArgs(["click", "--button=right"]).opts.button).toBe("right");
  });
  test("click modifiers are parsed as an action option", () => {
    expect(parseArgs(["click", "--modifiers=ctrl+shift"]).opts.modifiers).toBe("ctrl+shift");
  });
  test("--json is recognised but is not an option of the action", () => {
    const p = parseArgs(["os", "--json"]);
    expect(p.json).toBe(true);
    expect(p.action).toBe("os");
  });
  test("the diff tolerance defaults to 1 percent, and zero is respected", () => {
    expect(parseArgs(["diff", "a.png", "b.png"]).opts.sameUnder).toBe(1);
    expect(parseArgs(["diff", "a.png", "b.png", "--same-under=0"]).opts.sameUnder).toBe(0);
  });
});

describe("what a session remembers", () => {
  const session = { app: "TextEdit", window: "target", timeoutMs: 9000, force: false };

  test("a line can leave out what the session already knows", () => {
    const merged = withSession(parseArgs(["click", "--element=Save"]).opts, session);
    expect(merged.app).toBe("TextEdit");
    expect(merged.element).toBe("Save");
  });
  test("but the line always wins", () => {
    const merged = withSession(parseArgs(["click", "--app=Finder"]).opts, session);
    expect(merged.app).toBe("Finder");
  });
  test("force is sticky once set, since it is a decision about the session", () => {
    expect(withSession(parseArgs(["type", "x"]).opts, { ...session, force: true }).force).toBe(true);
  });
  test("an empty session changes nothing", () => {
    const bare = parseArgs(["type", "x"]).opts;
    expect(withSession(bare, {}).app).toBeUndefined();
  });
});
