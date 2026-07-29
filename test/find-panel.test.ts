import { test, expect, describe } from "bun:test";
import { findPanel, findButton, inside, type El } from "../rig/find-panel.ts";

// Trimmed from a real dump the rig produced on a macOS runner: Chrome with a
// file panel open. The coordinates are the ones that cost two CI rounds.
const REAL: El[] = [
  { role: "window", name: "cuse rig - file input - Google Chrome for Testing", x: 22, y: 53, width: 980, height: 630 },
  { role: "toolbar", name: "", x: 22, y: 93, width: 980, height: 46 },
  { role: "button", name: "Back", x: 24, y: 99, width: 34, height: 34 },
  { role: "radio", name: "cuse rig - file input", x: 374, y: 53, width: 256, height: 41 },
  // Chrome's own, up in the tab strip. This is what used to get clicked.
  { role: "button", name: "Cancel", x: 172, y: 40, width: 26, height: 16 },
  { role: "dialog", name: "open", x: 72, y: 144, width: 880, height: 448 },
  { role: "splitgroup", name: "", x: 72, y: 144, width: 880, height: 448 },
  // Note the outline is taller than the dialog: panel children can report
  // scrollable content larger than the window holding them.
  { role: "outline", name: "sidebar", x: 79, y: 151, width: 145, height: 790 },
  { role: "button", name: "Cancel", x: 700, y: 540, width: 80, height: 24 },
  { role: "button", name: "Open", x: 800, y: 540, width: 80, height: 24 },
];

describe("finding the file panel in a tree that is mostly browser", () => {
  test("the panel is the dialog, not the sidebar inside it", () => {
    const p = findPanel(REAL)!;
    // The first version matched the outline and then used its rectangle as the
    // panel's, which is 790 tall and reaches most of the screen.
    expect(p.role).toBe("dialog");
    expect(p.name).toBe("open");
  });
  test("macOS titles it lowercase, and does not call it a window", () => {
    expect(findPanel([{ role: "dialog", name: "open", x: 0, y: 0, width: 800, height: 400 }])).not.toBeNull();
    expect(findPanel([{ role: "window", name: "Open", x: 0, y: 0, width: 800, height: 400 }])).not.toBeNull();
  });
  test("a tree with no panel says so rather than picking something", () => {
    const chromeOnly = REAL.filter((e) => !["dialog", "splitgroup", "outline"].includes(e.role));
    expect(findPanel(chromeOnly)).toBeNull();
  });
  test("structure is the fallback when the title is not there", () => {
    const untitled = REAL.filter((e) => e.role !== "dialog").map((e) => ({ ...e }));
    expect(findPanel(untitled)!.role).toBe("splitgroup");
  });
});

describe("the button that belongs to the panel", () => {
  const panel = findPanel(REAL)!;

  test("Chrome's own Cancel is not in the panel", () => {
    const strayCancel = REAL.find((e) => e.name === "Cancel" && e.y === 40)!;
    expect(inside(panel, strayCancel)).toBe(false);
  });
  test("the panel's Cancel is the one that gets pressed", () => {
    expect(findButton(REAL, panel, "Cancel")).toMatchObject({ x: 700, y: 540 });
  });
  test("case does not matter, since a tree spells it how it likes", () => {
    expect(findButton(REAL, panel, "cancel")).toMatchObject({ x: 700, y: 540 });
  });
  test("a name with no button inside the panel is null, not the nearest one", () => {
    expect(findButton(REAL, panel, "Save")).toBeNull();
  });
  test("a control on the panel's own edge still counts", () => {
    const edge: El = { role: "button", name: "Open", x: panel.x - 4, y: panel.y - 2, width: 40, height: 20 };
    expect(inside(panel, edge)).toBe(true);
  });
  test("but not one a hundred pixels above it", () => {
    const above: El = { role: "button", name: "Open", x: panel.x, y: panel.y - 100, width: 40, height: 20 };
    expect(inside(panel, above)).toBe(false);
  });
});
