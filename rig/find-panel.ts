// Find the native file panel in a cuse element dump, and the button to press.
//
// One script rather than an inline snippet per step, because the first version
// had the logic twice and the two copies disagreed: the detector matched the
// sidebar outline, the clicker used that as the panel's rectangle with 400px of
// slop, and pressed something in the tab strip at 185,48.
//
//   bun rig/find-panel.ts <elements.json> [button-name]
//
// Prints one line: `NO-PANEL`, or `PANEL <role> <name> <x>,<y> <w>x<h>`
// followed by `BUTTON <x> <y>` when the named button is found inside it.
export type El = { role: string; name: string; x: number; y: number; width: number; height: number };

/**
 * Which of these controls is the file panel?
 *
 * macOS reports the open panel as a dialog titled "open" - lowercase, and not a
 * window, which is what the first attempt looked for. The fallbacks are its
 * structure: a large split group, or the sidebar outline it always carries.
 */
export function findPanel(els: El[]): El | null {
  return (
    els.find((e) => /^(dialog|sheet|window)$/.test(e.role) && /^open$/i.test(e.name)) ??
    els.find((e) => e.role === "splitgroup" && e.width > 400 && e.height > 300) ??
    els.find((e) => e.role === "outline" && /sidebar/i.test(e.name)) ??
    null
  );
}

/**
 * Strictly inside, with a few pixels for a control sitting on the panel's edge.
 *
 * No more than that. A generous test is what let a Cancel ninety-six pixels
 * above the panel, up in the tab strip, count as being in it.
 */
const SLOP = 8;
export function inside(panel: El, e: El): boolean {
  return e.x >= panel.x - SLOP && e.y >= panel.y - SLOP &&
    e.x + e.width <= panel.x + panel.width + SLOP &&
    e.y + e.height <= panel.y + panel.height + SLOP;
}

/** The named button belonging to the panel: inside it, and the smallest such. */
export function findButton(els: El[], panel: El, name: string): El | null {
  return els
    .filter((e) => e.role === "button" && e.name.toLowerCase() === name.toLowerCase())
    .filter((e) => inside(panel, e))
    .sort((a, b) => a.width * a.height - b.width * b.height)[0] ?? null;
}

if (import.meta.main) {
  const [file, wanted = "Cancel"] = process.argv.slice(2);
  if (!file) throw new Error("usage: find-panel.ts <elements.json> [button]");
  const els: El[] = (await Bun.file(file).json()).data ?? [];
  const panel = findPanel(els);
  if (!panel) {
    console.log("NO-PANEL");
    process.exit(0);
  }
  console.log(`PANEL ${panel.role} ${JSON.stringify(panel.name)} ${panel.x},${panel.y} ${panel.width}x${panel.height}`);
  for (const e of els.filter((e) => e.role === "button" && e.name.toLowerCase() === wanted.toLowerCase())) {
    console.error(`  candidate ${inside(panel, e) ? "inside " : "outside"} ${e.width}x${e.height} at ${e.x},${e.y}`);
  }
  const hit = findButton(els, panel, wanted);
  if (hit) console.log(`BUTTON ${Math.round(hit.x + hit.width / 2)} ${Math.round(hit.y + hit.height / 2)}`);
}
