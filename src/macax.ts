// The macOS accessibility tree, read directly instead of through AppleScript.
//
// Every attribute asked for through System Events is an Apple Event: a message
// to another process, answered on its main thread. Reading one control's role,
// name, position and size is four round trips, and a window with three hundred
// controls is twelve hundred. Asking in bulk (`role of UI elements of el`) got
// that down to four per container and was enough for TextEdit, but Finder still
// took longer than cuse's own deadline and came back as a timeout - the tree of
// the most ordinary app on the machine was simply unreadable.
//
// The same tree is available through the C API the Apple Events were reaching
// anyway. In this process, with the multiple-attribute call, Finder answers 300
// controls in about 350ms rather than never.
//
// Not unit-testable, like `macos.ts` - it does not compute anything, it asks the
// window server. What is testable lives in `parseProcessList` below and in
// elements.ts. What proves the rest is CI reading a real TextEdit window.
const AX_PATH = "/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices";
const CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const UTF8 = 0x08000100;
const POINT = 1, SIZE = 2;   // AXValueType

/**
 * Handles are u64, not `ptr`.
 *
 * CoreFoundation returns tagged pointers for short strings - the value carries
 * the contents in its high bits rather than addressing them - and bun's `ptr`
 * type mangles those into a different number. Every CFTypeRef here is therefore
 * an opaque 64-bit integer, which is what it is. Getting this wrong segfaults
 * on the first string, which is how it was found.
 */
type Symbols = {
  ax: Record<string, (...args: any[]) => any>;
  cf: Record<string, (...args: any[]) => any>;
  ptr: (value: ArrayBufferView) => any;
};

async function open(): Promise<Symbols> {
  if (typeof Bun !== "undefined") {
    const { dlopen, FFIType: T, ptr } = await import("bun:ffi");
    const ax = dlopen(AX_PATH, {
    AXUIElementCreateApplication: { args: [T.i32], returns: T.u64 },
    AXUIElementCopyAttributeValue: { args: [T.u64, T.u64, T.ptr], returns: T.i32 },
    AXUIElementCopyMultipleAttributeValues: { args: [T.u64, T.u64, T.u32, T.ptr], returns: T.i32 },
    AXUIElementSetMessagingTimeout: { args: [T.u64, T.f32], returns: T.i32 },
    AXValueGetValue: { args: [T.u64, T.u32, T.ptr], returns: T.bool },
    AXValueGetTypeID: { args: [], returns: T.u64 },
    AXIsProcessTrusted: { args: [], returns: T.bool },
  });
    const cf = dlopen(CF_PATH, {
    CFStringCreateWithCString: { args: [T.u64, T.ptr, T.u32], returns: T.u64 },
    CFStringGetCString: { args: [T.u64, T.ptr, T.i64, T.u32], returns: T.bool },
    CFStringGetTypeID: { args: [], returns: T.u64 },
    CFArrayCreate: { args: [T.u64, T.ptr, T.i64, T.u64], returns: T.u64 },
    CFArrayGetCount: { args: [T.u64], returns: T.i64 },
    CFArrayGetValueAtIndex: { args: [T.u64, T.i64], returns: T.u64 },
    CFArrayGetTypeID: { args: [], returns: T.u64 },
    CFGetTypeID: { args: [T.u64], returns: T.u64 },
    CFRelease: { args: [T.u64], returns: T.void },
    CFBooleanGetTypeID: { args: [], returns: T.u64 },
    CFBooleanGetValue: { args: [T.u64], returns: T.bool },
    CFNumberGetTypeID: { args: [], returns: T.u64 },
    CFNumberGetValue: { args: [T.u64, T.i64, T.ptr], returns: T.bool },
  });
    return { ax: ax.symbols, cf: cf.symbols, ptr } as Symbols;
  }

  const koffi = await import("koffi");
  const ax = koffi.load(AX_PATH);
  const cf = koffi.load(CF_PATH);
  return {
    ax: {
      AXUIElementCreateApplication: ax.func("AXUIElementCreateApplication", "uint64", ["int32"]),
      AXUIElementCopyAttributeValue: ax.func("AXUIElementCopyAttributeValue", "int32", ["uint64", "uint64", "void *"]),
      AXUIElementCopyMultipleAttributeValues: ax.func("AXUIElementCopyMultipleAttributeValues", "int32", ["uint64", "uint64", "uint32", "void *"]),
      AXUIElementSetMessagingTimeout: ax.func("AXUIElementSetMessagingTimeout", "int32", ["uint64", "float"]),
      AXValueGetValue: ax.func("AXValueGetValue", "bool", ["uint64", "uint32", "void *"]),
      AXValueGetTypeID: ax.func("AXValueGetTypeID", "uint64", []),
      AXIsProcessTrusted: ax.func("AXIsProcessTrusted", "bool", []),
    },
    cf: {
      CFStringCreateWithCString: cf.func("CFStringCreateWithCString", "uint64", ["uint64", "void *", "uint32"]),
      CFStringGetCString: cf.func("CFStringGetCString", "bool", ["uint64", "void *", "int64", "uint32"]),
      CFStringGetTypeID: cf.func("CFStringGetTypeID", "uint64", []),
      CFArrayCreate: cf.func("CFArrayCreate", "uint64", ["uint64", "void *", "int64", "uint64"]),
      CFArrayGetCount: cf.func("CFArrayGetCount", "int64", ["uint64"]),
      CFArrayGetValueAtIndex: cf.func("CFArrayGetValueAtIndex", "uint64", ["uint64", "int64"]),
      CFArrayGetTypeID: cf.func("CFArrayGetTypeID", "uint64", []),
      CFGetTypeID: cf.func("CFGetTypeID", "uint64", ["uint64"]),
      CFRelease: cf.func("CFRelease", "void", ["uint64"]),
      CFBooleanGetTypeID: cf.func("CFBooleanGetTypeID", "uint64", []),
      CFBooleanGetValue: cf.func("CFBooleanGetValue", "bool", ["uint64"]),
      CFNumberGetTypeID: cf.func("CFNumberGetTypeID", "uint64", []),
      CFNumberGetValue: cf.func("CFNumberGetValue", "bool", ["uint64", "int64", "void *"]),
    },
    ptr: (value) => value,
  };
}

let lib: Symbols | null = null;
async function syms(): Promise<Symbols> {
  if (!lib) lib = await open();
  return lib;
}

export type Raw = {
  role: string; name: string; x: number; y: number; width: number; height: number;
  value?: string; enabled?: boolean; focused?: boolean;
  selected?: boolean; expanded?: boolean; automationId?: string;
  checked?: boolean;
};

/**
 * What came back, and whether it is all of it.
 *
 * A walk that stops early returns a tree missing the control the caller asked
 * about, which is indistinguishable from an app that does not have it. The rig
 * hit exactly that: a file panel was found, its Cancel button was not, and the
 * reason was the clock rather than the app. Silence there is the whole failure
 * mode this tool exists to refuse.
 */
export type Walk = { rows: Raw[]; stopped?: "deadline" | "limit" };

/** Is this process allowed to read other apps' trees at all? */
export async function trusted(): Promise<boolean> {
  return (await syms()).ax.AXIsProcessTrusted();
}

export const UNTRUSTED =
  "this process is not trusted for accessibility, so no app will show its controls - " +
  "grant Accessibility to the terminal running cuse in System Settings > Privacy & Security";

/**
 * Every control of an application's windows.
 *
 * Bounded three ways, because an accessibility tree is someone else's data
 * structure: a node cap, a depth cap, and a wall-clock deadline. The messaging
 * timeout is the fourth - an app that stops answering must not hold the walk
 * open, which is the same lesson `exec.ts` learned about child processes.
 */
export async function elementsOfPid(pid: number, limit = 300, maxDepth = 12,
                                    deadline = Date.now() + 15_000): Promise<Walk> {
  const { ax, cf, ptr } = await syms();
  const STRING_ID = cf.CFStringGetTypeID();
  const ARRAY_ID = cf.CFArrayGetTypeID();
  const VALUE_ID = ax.AXValueGetTypeID();

  const strs = new Map<string, bigint>();
  const cfstr = (s: string): bigint => {
    let p = strs.get(s);
    if (p === undefined) {
      p = cf.CFStringCreateWithCString(0n, ptr(Buffer.from(`${s}\0`)), UTF8);
      strs.set(s, p);
    }
    return p;
  };

  const one = new BigUint64Array(1);
  const onePtr = ptr(one);
  const copyAttr = (el: bigint, attr: string): bigint => {
    one[0] = 0n;
    return ax.AXUIElementCopyAttributeValue(el, cfstr(attr), onePtr) === 0 ? one[0]! : 0n;
  };

  const text = new Uint8Array(2048);
  const textPtr = ptr(text);
  const toStr = (v: bigint): string => {
    if (!v || cf.CFGetTypeID(v) !== STRING_ID) return "";
    if (!cf.CFStringGetCString(v, textPtr, 2048n, UTF8)) return "";
    const end = text.indexOf(0);
    return new TextDecoder().decode(text.subarray(0, end < 0 ? 2048 : end));
  };

  const pair = new Float64Array(2);
  const pairPtr = ptr(pair);
  const axPair = (v: bigint, kind: number): [number, number] | null => {
    if (!v || cf.CFGetTypeID(v) !== VALUE_ID) return null;
    if (!ax.AXValueGetValue(v, kind, pairPtr)) return null;
    return [pair[0]!, pair[1]!];
  };

  const BOOL_ID = cf.CFBooleanGetTypeID();
  // Type-checked like `toStr`, for the same reason: a backend that cannot
  // answer AXEnabled or AXFocused must come back undefined, never false.
  const axBool = (v: bigint): boolean | undefined => {
    if (!v || cf.CFGetTypeID(v) !== BOOL_ID) return undefined;
    return cf.CFBooleanGetValue(v);
  };

  const NUMBER_ID = cf.CFNumberGetTypeID();
  const SINT32 = 3; // kCFNumberSInt32Type
  const num = new Int32Array(1);
  const numPtr = ptr(num);
  // AXCheckBox and AXRadioButton report their state as a CFNumber, not the
  // CFBoolean other controls use: an NSButton's `state` is 0/1/2 for
  // off/on/mixed. Type-checked like `axBool`, so a control whose AXValue is
  // some other CFNumber (a slider, say) or no number at all also comes back
  // undefined rather than a guessed boolean. 2 (mixed) is deliberately left
  // undefined too: collapsing a tri-state checkbox into true or false would be
  // exactly the "missing state reported as false" issue #35 rules out.
  const axNumber = (v: bigint): boolean | undefined => {
    if (!v || cf.CFGetTypeID(v) !== NUMBER_ID) return undefined;
    if (!cf.CFNumberGetValue(v, SINT32, numPtr)) return undefined;
    const n = num[0];
    return n === 0 ? false : n === 1 ? true : undefined;
  };

  // One message per element instead of six. A control's name lives under
  // whichever of these it happens to use: a button has a title, an image has a
  // description, a text area has only its contents.
  // AXSelected/AXExpanded/AXIdentifier ride along the same call: a tab or list
  // row's selection state, an outline row's disclosure state, and a UI test
  // identifier are each a single direct attribute read, same shape as
  // AXEnabled/AXFocused above.
  const ATTRS = [
    "AXRole", "AXTitle", "AXDescription", "AXValue", "AXPosition", "AXSize", "AXEnabled", "AXFocused",
    "AXSelected", "AXExpanded", "AXIdentifier",
  ];
  const attrHandles = new BigUint64Array(ATTRS.map(cfstr));
  const attrArray = cf.CFArrayCreate(0n, ptr(attrHandles), BigInt(ATTRS.length), 0n);
  const many = new BigUint64Array(1);
  const manyPtr = ptr(many);

  const rows: Raw[] = [];
  let stopped: Walk["stopped"];

  const app = ax.AXUIElementCreateApplication(pid);
  if (!app) return { rows };
  // Seconds. An unresponsive app should cost one attribute, not the run.
  ax.AXUIElementSetMessagingTimeout(app, 5);

  const walk = (el: bigint, depth: number): void => {
    if (rows.length >= limit) { stopped = "limit"; return; }
    if (Date.now() > deadline) { stopped = "deadline"; return; }
    if (depth > maxDepth) return;

    many[0] = 0n;
    if (ax.AXUIElementCopyMultipleAttributeValues(el, attrArray, 0, manyPtr) === 0 && many[0]) {
      const arr = many[0]!;
      const at = (i: number) => cf.CFArrayGetValueAtIndex(arr, BigInt(i));
      const role = toStr(at(0));
      const name = toStr(at(1)) || toStr(at(2)) || toStr(at(3));
      const pos = axPair(at(4), POINT);
      const size = axPair(at(5), SIZE);
      const enabled = axBool(at(6));
      const focused = axBool(at(7));
      const value = toStr(at(3)) || undefined;
      const selected = axBool(at(8));
      const expanded = axBool(at(9));
      const automationId = toStr(at(10)) || undefined;
      // Same handle as `value` above, read a second way: AXValue is a string
      // on most controls but a CFNumber on a checkbox or radio button.
      const checked = axNumber(at(3));
      if (pos && size && size[0] > 0 && size[1] > 0) {
        rows.push({
          role, name, x: pos[0], y: pos[1], width: size[0], height: size[1],
          ...(value !== undefined ? { value } : {}),
          ...(enabled !== undefined ? { enabled } : {}),
          ...(focused !== undefined ? { focused } : {}),
          ...(selected !== undefined ? { selected } : {}),
          ...(expanded !== undefined ? { expanded } : {}),
          ...(automationId !== undefined ? { automationId } : {}),
          ...(checked !== undefined ? { checked } : {}),
        });
      }
      cf.CFRelease(arr);
    }

    const kids = copyAttr(el, "AXChildren");
    if (!kids) return;
    if (cf.CFGetTypeID(kids) === ARRAY_ID) {
      const n = Number(cf.CFArrayGetCount(kids));
      for (let i = 0; i < n; i++) {
        if (rows.length >= limit) { stopped = "limit"; break; }
        const child = cf.CFArrayGetValueAtIndex(kids, BigInt(i));
        if (child) walk(child, depth + 1);
      }
    }
    cf.CFRelease(kids);
  };

  // The focused window first, and separately, because a modal panel is often
  // not in AXWindows at all. macOS raises the file panel out of process, and
  // from the browser's element it appears as a childless `dialog` node while its
  // real contents - sidebar, column browser, Cancel and Open - hang off
  // AXFocusedWindow. Walking only AXWindows found the dialog and none of its
  // controls, which reads exactly like a panel with no buttons in it.
  // Guarded by its role. `AXFocusedWindow` does not always answer with a window:
  // asked of some applications it hands back something whose subtree is the menu
  // bar, and walking that put a hundred menu items in front of the controls
  // anyone actually asked for.
  const roleOf = (el: bigint): string => {
    const v = copyAttr(el, "AXRole");
    if (!v) return "";
    const r = toStr(v);
    cf.CFRelease(v);
    return r;
  };
  for (const attr of ["AXFocusedWindow", "AXMainWindow"]) {
    const el = copyAttr(app, attr);
    if (!el) continue;
    const role = roleOf(el);
    // Guarded by role: asked of some applications these hand back the element
    // whose subtree is the menu bar, and walking that puts a hundred menu items
    // in front of the controls anyone asked for.
    if (/^AX(Window|Sheet|Dialog|Popover)$/.test(role)) walk(el, 0);
    else console.error(`cuse: ${attr} is a ${role || "?"}, not a window; skipping it`);
    cf.CFRelease(el);
  }

  // Then the ordinary windows. Not the application element itself: its children
  // include the menu bar, hundreds of nodes nobody asked about, which would eat
  // the whole budget before reaching a window.
  const wins = copyAttr(app, "AXWindows");
  if (wins) {
    if (cf.CFGetTypeID(wins) === ARRAY_ID) {
      const n = Number(cf.CFArrayGetCount(wins));
      for (let i = 0; i < n; i++) {
        if (rows.length >= limit) { stopped = "limit"; break; }
        walk(cf.CFArrayGetValueAtIndex(wins, BigInt(i)), 0);
      }
    }
    cf.CFRelease(wins);
  }
  cf.CFRelease(app);
  // The focused window is usually also in AXWindows, so the same control can be
  // collected twice. Identical role, name and rectangle is the same control for
  // every purpose a caller has.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.role}|${r.name}|${r.x}|${r.y}|${r.width}|${r.height}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { rows: unique, stopped };
}
