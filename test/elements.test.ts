import { test, expect, describe } from "bun:test";
import {
  elementsCmd, parseElements, pickElement, pointInElement,
  normalizeRole, resolveWindowsRole, describeMisses, geometryLooksUsable, type Element,
} from "../src/elements.ts";
import type { OS } from "../src/os.ts";

const el = (over: Partial<Element>): Element => ({
  role: "button", rawRole: "AXButton", name: "Save",
  x: 0, y: 0, width: 80, height: 24, ...over,
});

describe("one vocabulary for three trees", () => {
  test("the same control has the same role whatever the OS calls it", () => {
    expect(normalizeRole("AXButton")).toBe("button");       // macOS
    expect(normalizeRole("Button")).toBe("button");         // Windows UIA
    expect(normalizeRole("push button")).toBe("button");    // AT-SPI
  });
  test("text entry too", () => {
    expect(normalizeRole("AXTextField")).toBe("text");
    expect(normalizeRole("Edit")).toBe("text");
    expect(normalizeRole("text")).toBe("label");            // AT-SPI static text
    expect(normalizeRole("AXTextArea")).toBe("text");
  });
  test("an unknown role is passed through, not swallowed", () => {
    expect(normalizeRole("AXSomethingNew")).toBe("somethingnew");
    expect(normalizeRole("")).toBe("unknown");
  });
});

describe("asking each platform", () => {
  test("every OS has a way", () => {
    for (const os of ["macos", "linux", "windows"] as OS[]) {
      expect(elementsCmd(os, "TextEdit").length).toBeGreaterThan(0);
    }
  });
  test("macOS asks System Events for whole lists, not one control at a time", () => {
    const c = elementsCmd("macos", "TextEdit").join(" ");
    // Four Apple Events per container; per-control it was four each, and Finder
    // then took longer than the deadline.
    // Asked of the container, not of a saved list: `role of kids` is not a
    // query AppleScript can answer, and asking it returned an empty tree.
    expect(c).toContain("role of UI elements of el");
    expect(c).toContain("position of UI elements of el");
    expect(c).not.toContain("role of kids");
  });
  test("windows walks UI Automation descendants", () => {
    const c = elementsCmd("windows", "CU_TARGET").join(" ");
    expect(c).toContain("Descendants");
    expect(c).toContain("BoundingRectangle");
  });
  test("linux names what is missing instead of returning nothing", () => {
    const c = elementsCmd("linux", "xterm").join(" ");
    expect(c).toContain("pyatspi");
    expect(c).toContain("apt-get install");
  });
  test("every backend is capped, so a huge tree cannot hang the caller", () => {
    for (const os of ["macos", "linux", "windows"] as OS[]) {
      expect(elementsCmd(os, "x", 42).join(" ")).toContain("42");
    }
  });
  test("an app name with a quote cannot break out of the script", () => {
    expect(elementsCmd("windows", "it's").join(" ")).toContain("it''s");
  });
});

describe("parsing what they print", () => {
  test("reads a row and normalises its role", () => {
    expect(parseElements("AXButton\tSave\t10\t20\t80\t24\n")).toEqual([
      { role: "button", rawRole: "AXButton", name: "Save", x: 10, y: 20, width: 80, height: 24 },
    ]);
  });
  test("keeps a name that contains spaces", () => {
    expect(parseElements("Button\tSave As...\t0\t0\t9\t9\n")[0]!.name).toBe("Save As...");
  });
  test("skips rows with no rectangle rather than inventing one", () => {
    const text = "Button\tGhost\t0\t0\t0\t0\nButton\tReal\t1\t2\t3\t4\nnonsense\n";
    expect(parseElements(text).map((e) => e.name)).toEqual(["Real"]);
  });
  test("an unnamed control still counts - plenty of real ones have no name", () => {
    expect(parseElements("Edit\t\t5\t5\t100\t20\n")[0]).toMatchObject({ role: "text", name: "" });
  });
});

describe("choosing the control the agent meant", () => {
  const els = [
    el({ name: "Save", role: "group", width: 400, height: 300 }),
    el({ name: "Save", role: "button", x: 10, y: 10 }),
    el({ name: "Save As...", role: "button", x: 100, y: 10 }),
    el({ name: "Cancel", role: "button", x: 200, y: 10 }),
  ];

  test("finds by name, case-insensitively", () => {
    expect(pickElement(els, { name: "cancel" })!.x).toBe(200);
  });
  test("an exact name beats a longer one that merely contains it", () => {
    expect(pickElement(els, { name: "Save", role: "button" })!.x).toBe(10);
  });
  test("role narrows it: the button, not the group around it", () => {
    expect(pickElement(els, { name: "Save", role: "button" })!.role).toBe("button");
  });
  test("without a role, the smallest match wins - clicking the group is wrong", () => {
    expect(pickElement(els, { name: "Save" })!.role).toBe("button");
  });
  test("role alone is a valid selector", () => {
    expect(pickElement(els, { role: "group" })!.name).toBe("Save");
  });
  test("no match is null, not a guess", () => {
    expect(pickElement(els, { name: "Print" })).toBeNull();
    expect(pickElement(els, { name: "Save", role: "checkbox" })).toBeNull();
  });
  test("the click goes to the middle of the control", () => {
    expect(pointInElement(el({ x: 10, y: 20, width: 80, height: 24 }))).toEqual({ x: 50, y: 32 });
  });
  test("a fraction aims inside it, for a control that is not a plain button", () => {
    expect(pointInElement(el({ x: 0, y: 0, width: 100, height: 100 }), 0.25, 0.75)).toEqual({ x: 25, y: 75 });
  });
});

describe("when nothing matches", () => {
  const els = [el({ name: "Save" }), el({ name: "Cancel" }), el({ name: "", role: "group" })];
  test("says what was there instead of failing silently", () => {
    const msg = describeMisses(els, { name: "Print" });
    expect(msg).toContain("Save");
    expect(msg).toContain("Cancel");
  });
  test("filters the suggestions by the role that was asked for", () => {
    expect(describeMisses(els, { name: "Print", role: "button" })).toContain("button 'Save'");
  });
  test("says so plainly when there is nothing named at all", () => {
    expect(describeMisses([el({ name: "" })], { name: "x" })).toContain("no named controls");
  });
});

describe("a label is not a button", () => {
  // GTK exposes a button's own text as a separate label with the same name, and
  // AT-SPI gave that label a 0,0 rectangle - so picking it clicked the corner
  // of the screen instead of the control.
  const tree = [
    el({ role: "label", rawRole: "label", name: "Cancel", x: 0, y: 0, width: 123, height: 24 }),
    el({ role: "button", rawRole: "push button", name: "Cancel", x: 520, y: 400, width: 90, height: 34 }),
  ];

  test("the pressable one wins when the name is ambiguous", () => {
    const hit = pickElement(tree, { name: "Cancel" })!;
    expect(hit.role).toBe("button");
    expect([hit.x, hit.y]).toEqual([520, 400]);
  });
  test("asking for the label explicitly still gives the label", () => {
    expect(pickElement(tree, { name: "Cancel", role: "label" })!.role).toBe("label");
  });
  test("among two pressable controls, the smaller still wins", () => {
    const two = [
      el({ role: "button", name: "Save", width: 400, height: 300 }),
      el({ role: "button", name: "Save", width: 90, height: 30, x: 5 }),
    ];
    expect(pickElement(two, { name: "Save" })!.width).toBe(90);
  });
});

describe("a tree that does not know where anything is", () => {
  test("everything stacked at the origin is not a layout", () => {
    // zenity under a bare Xvfb: 17 controls, correct roles and names, and every
    // rectangle at 0,0. Aiming at that clicks the corner of the screen.
    const piled = [el({ x: 0, y: 0 }), el({ name: "Cancel", x: 0, y: 0 }), el({ name: "OK", x: 0, y: 0 })];
    expect(geometryLooksUsable(piled)).toBe(false);
  });
  test("one positioned control is enough to trust the rest", () => {
    expect(geometryLooksUsable([el({ x: 0, y: 0 }), el({ x: 520, y: 400 })])).toBe(true);
  });
  test("a single control at the origin is plausible, not a symptom", () => {
    expect(geometryLooksUsable([el({ x: 0, y: 0 })])).toBe(true);
  });
});

describe("Windows roles when UI Automation shrugs", () => {
  test("a specific UIA type wins, because it is the better source", () => {
    expect(resolveWindowsRole("Button|43")).toBe("button");
    expect(resolveWindowsRole("Edit|42")).toBe("text");
  });
  test("a vague UIA type falls back to what the legacy interface says", () => {
    // The case that motivated this: WinForms answers Pane for a real button.
    expect(resolveWindowsRole("Pane|43")).toBe("button");
    expect(resolveWindowsRole("Pane|42")).toBe("text");
    expect(resolveWindowsRole("Custom|44")).toBe("checkbox");
  });
  test("when neither knows, the vague answer stands rather than a guess", () => {
    expect(resolveWindowsRole("Pane|0")).toBe("group");
    expect(resolveWindowsRole("Pane|")).toBe("group");
  });
  test("parsing a Windows row resolves the role and keeps what was reported", () => {
    const [e] = parseElements("Pane|43\tSave\t112\t336\t684\t60\n");
    expect(e!.role).toBe("button");
    expect(e!.rawRole).toBe("Pane|43");
  });
  test("the other platforms are untouched by the composite form", () => {
    expect(normalizeRole("AXButton")).toBe("button");
    expect(normalizeRole("push button")).toBe("button");
  });
  test("with real roles, --role=button finds the button WinForms called a pane", () => {
    const tree = parseElements(
      "Pane|42\tcuse input reached this window\t86\t109\t684\t180\n" +
      "Pane|43\tSave\t86\t310\t684\t60\n");
    const hit = pickElement(tree, { name: "Save", role: "button" })!;
    expect(hit).not.toBeNull();
    expect([hit.x, hit.y]).toEqual([86, 310]);
  });
});
