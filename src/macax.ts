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
import { dlopen, FFIType as T, ptr } from "bun:ffi";

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
function open() {
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
  });
  return { ax: ax.symbols, cf: cf.symbols };
}

type Syms = ReturnType<typeof open>;
let lib: Syms | null = null;
const syms = (): Syms => (lib ??= open());

export type Raw = { role: string; name: string; x: number; y: number; width: number; height: number };

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
export function trusted(): boolean {
  return syms().ax.AXIsProcessTrusted();
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
export function elementsOfPid(pid: number, limit = 300, maxDepth = 12,
                              deadline = Date.now() + 15_000): Walk {
  const { ax, cf } = syms();
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

  // One message per element instead of six. A control's name lives under
  // whichever of these it happens to use: a button has a title, an image has a
  // description, a text area has only its contents.
  const ATTRS = ["AXRole", "AXTitle", "AXDescription", "AXValue", "AXPosition", "AXSize"];
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
      if (pos && size && size[0] > 0 && size[1] > 0) {
        rows.push({ role, name, x: pos[0], y: pos[1], width: size[0], height: size[1] });
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

  // Windows, not the application element: an app's own children include its
  // menu bar, which is hundreds of nodes nobody asked about and would eat the
  // whole node budget before reaching the window.
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
  return { rows, stopped };
}
