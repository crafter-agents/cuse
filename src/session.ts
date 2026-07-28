// Is anyone actually able to receive input right now?
//
// A locked Mac still accepts synthetic events: they go to the login window, so
// `cuse type` silently fills the password field. That is the worst possible place
// for a stray keystroke, so input actions check the session first.
//
// The parsing is pure and the probe is injected, which keeps this testable
// without locking the machine running the tests.
import type { OS } from "./os.ts";

/**
 * Read the lock flag out of `ioreg -n Root -d1 -a`. The value lives in the
 * IOConsoleUsers dictionary as a plist key followed by <true/> or <false/>.
 */
export function parseMacLockState(ioregPlist: string): boolean | null {
  const at = ioregPlist.indexOf("CGSSessionScreenIsLocked");
  if (at === -1) return null; // key absent: no console session to speak of
  const after = ioregPlist.slice(at, at + 200);
  if (/<true\s*\/>/.test(after)) return true;
  if (/<false\s*\/>/.test(after)) return false;
  return null;
}

/** Windows shows the secure desktop through LogonUI; if it runs, we are locked. */
export function parseWindowsLockState(tasklistOutput: string): boolean {
  return /logonui\.exe/i.test(tasklistOutput);
}

export type SessionProbe = {
  os: OS;
  /** raw output of the platform's lock query, or null if it could not be run */
  read: () => Promise<string | null>;
};

export const LOCK_QUERY: Partial<Record<OS, string[]>> = {
  macos: ["ioreg", "-n", "Root", "-d1", "-a"],
  windows: ["tasklist", "/FI", "IMAGENAME eq LogonUI.exe"],
  // A Linux X session under Xvfb has no lock screen, and a desktop lock varies
  // by screensaver - so there is nothing dependable to check.
};

/** true = locked, false = unlocked, null = could not tell (never block on null). */
export async function isSessionLocked(probe: SessionProbe): Promise<boolean | null> {
  const raw = await probe.read();
  if (raw === null) return null;
  if (probe.os === "macos") return parseMacLockState(raw);
  if (probe.os === "windows") return parseWindowsLockState(raw);
  return null;
}

/**
 * An empty list of windows means one of two very different things.
 *
 * With the screen locked, nothing can be enumerated - System Events sees no
 * application windows at all - and "no titled windows" then reads as "the
 * desktop is empty" when the truth is "I cannot see". Anything that reports a
 * view of the screen has to say which of the two it is.
 */
export function blindNote(locked: boolean | null, sawNothing: boolean): string | undefined {
  if (!sawNothing) return undefined;
  if (locked === true) return "nothing could be seen because the screen is locked, not because nothing is there";
  return undefined;
}

export const LOCKED_REASON =
  "the session is locked: input would go to the login window, not to your app " +
  "(unlock the machine, or pass --force if you really mean it)";
