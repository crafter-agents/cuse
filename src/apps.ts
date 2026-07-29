// Which running process is "TextEdit"?
//
// Reading a macOS accessibility tree needs a pid, and an agent has a name. The
// answer is in `ps`: a GUI application runs its bundle's executable, so the path
// carries the name the user knows it by.
//
// Helper processes are the trap. A browser runs a dozen of them, each a real
// bundle nested inside the app's frameworks, and each therefore listed under its
// own name - "Browser Helper", not the browser. That is honest and mostly
// harmless, since nobody types that name; where it matters is a helper whose
// name contains the app's, so an exact match wins and the shallowest path breaks
// the tie.
export type App = { pid: number; bundle: string; path: string };

/** The processes on this machine, with the command that started each. */
export function runningAppsCmd(): string[] {
  return ["ps", "-Ax", "-o", "pid=,command="];
}

const BUNDLE = /\/([^/]+)\.app\/Contents\/MacOS\//g;

/**
 * Pull the application bundles out of a process list.
 *
 * The bundle is the one whose `Contents/MacOS` holds the running executable, so
 * a process is named by the bundle it actually is rather than the app that ships
 * it. A line with no bundle at all is a daemon, and has no window to read.
 */
export function parseApps(text: string): App[] {
  const out: App[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const path = m[2]!;
    BUNDLE.lastIndex = 0;
    const hit = BUNDLE.exec(path);
    if (!hit) continue;
    out.push({ pid: Number(m[1]), bundle: hit[1]!, path });
  }
  return out;
}

/**
 * Which of them did the caller mean?
 *
 * Case-insensitive substring, the rule `focus` and `windows` already use, with
 * an exact bundle name winning outright. Among equals the shallowest path wins:
 * a nested helper bundle is deeper than the app that ships it.
 */
export function pickApp(apps: App[], name: string): App | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const depth = (a: App) => (a.path.match(/\.app\//g) ?? []).length;
  const matches = apps
    .filter((a) => a.bundle.toLowerCase().includes(want))
    .sort((a, b) => {
      const exact = (x: App) => (x.bundle.toLowerCase() === want ? 0 : 1);
      if (exact(a) !== exact(b)) return exact(a) - exact(b);
      if (depth(a) !== depth(b)) return depth(a) - depth(b);
      return a.pid - b.pid;
    });
  return matches[0] ?? null;
}

/** What to say when nothing matched: the names that are there. */
export function describeApps(apps: App[], keep = 10): string {
  const names = [...new Set(apps.map((a) => a.bundle))].slice(0, keep);
  return names.length ? names.join(", ") : "no applications are running";
}
