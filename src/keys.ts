// Keys that have names rather than characters.
//
// Every platform spells them differently and none of them accept the plain word.
// SendKeys needs braces, so `alt+F4` sent as "%F4" types the letters f and 4 -
// which is why an app chooser sat there through five attempts to close it.
// System Events has no name for Escape at all and needs its virtual key code.
// xdotool takes keysyms, which are case-sensitive: "F4" works, "f4" does not.
//
// Lowercasing the whole chord, which is right for letters, is what broke all
// three. So named keys are recognised before case is touched.

/** The canonical name for a key, from however the caller spelled it. */
const ALIASES: Record<string, string> = {
  enter: "return", ret: "return", cr: "return",
  esc: "escape",
  del: "delete", backspace: "backspace", bs: "backspace",
  pgup: "pageup", pgdn: "pagedown", pagedn: "pagedown",
  spacebar: "space",
};

/** macOS virtual key codes, for the keys System Events cannot name. */
const MAC_CODES: Record<string, number> = {
  return: 36, tab: 48, space: 49, delete: 51, escape: 53, backspace: 51,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121,
  forwarddelete: 117,
};

/** SendKeys spellings, which are braced so they are not read as literal text. */
const WINDOWS_KEYS: Record<string, string> = {
  return: "{ENTER}", tab: "{TAB}", space: " ", escape: "{ESC}",
  backspace: "{BS}", delete: "{DEL}",
  left: "{LEFT}", right: "{RIGHT}", up: "{UP}", down: "{DOWN}",
  home: "{HOME}", end: "{END}", pageup: "{PGUP}", pagedown: "{PGDN}",
  insert: "{INS}",
};

/** xdotool keysyms, whose capitalisation matters. */
const LINUX_KEYS: Record<string, string> = {
  return: "Return", tab: "Tab", space: "space", escape: "Escape",
  backspace: "BackSpace", delete: "Delete",
  left: "Left", right: "Right", up: "Up", down: "Down",
  home: "Home", end: "End", pageup: "Prior", pagedown: "Next",
  insert: "Insert",
};

/** Is this a key with a name, rather than a character to type? */
export function canonicalKeyName(raw: string): string | null {
  const k = raw.trim().toLowerCase();
  const named = ALIASES[k] ?? k;
  if (named in MAC_CODES || named in WINDOWS_KEYS || named in LINUX_KEYS) return named;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(named)) return named;
  return null;
}

export function macKeyCode(name: string): number | undefined {
  return MAC_CODES[name];
}

export function windowsKey(name: string): string {
  return WINDOWS_KEYS[name] ?? `{${name.toUpperCase()}}`;
}

export function linuxKey(name: string): string {
  return LINUX_KEYS[name] ?? name.toUpperCase();
}
