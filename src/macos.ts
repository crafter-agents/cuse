// macOS mouse control through CoreGraphics.
//
// System Events, which handles keystrokes fine, has no mouse API at all - the
// AppleScript that looked like it moved the cursor ("set the position of the
// mouse") is not a real command and always failed with -2753. CoreGraphics is
// the actual input plane, and it ships with every Mac, so this needs no install.
//
// CGPoint is two doubles and, in the arm64 calling convention, a homogeneous
// float aggregate travels in the same float registers as two separate doubles -
// which is why the struct can be declared this way through FFI.
import { setTimeout as sleep } from "node:timers/promises";
import type { MouseButton } from "./plan.ts";

const CG_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const LEFT_DOWN = 1, LEFT_UP = 2, RIGHT_DOWN = 3, RIGHT_UP = 4, LEFT_DRAGGED = 6;
const OTHER_DOWN = 25, OTHER_UP = 26; // CGEventType
const CLICK_STATE = 1;              // CGEventField.kCGMouseEventClickState
const BUTTON_NUMBER = 3;            // CGEventField.kCGMouseEventButtonNumber
const HID_TAP = 0;                  // CGEventTapLocation.kCGHIDEventTap
const UNIT_LINE = 1;                // CGScrollEventUnit.kCGScrollEventUnitLine
const MODIFIER_FLAGS: Record<string, number> = {
  shift: 0x00020000,
  ctrl: 0x00040000,
  alt: 0x00080000,
  cmd: 0x00100000,
};

type Pointer = number | bigint;
type Symbols = {
  cg: Record<string, (...args: any[]) => any>;
  cf: Record<string, (...args: any[]) => any>;
};

let lib: Symbols | null = null;
let scroll2Lib: Symbols["cg"] | null = null;

async function open(): Promise<Symbols> {
  if (typeof Bun !== "undefined") {
    const { dlopen, FFIType: T } = await import("bun:ffi");
    const cg = dlopen(CG_PATH, {
      CGWarpMouseCursorPosition: { args: [T.double, T.double], returns: T.i32 },
      CGEventCreate: { args: [T.ptr], returns: T.ptr },
      CGEventCreateMouseEvent: { args: [T.ptr, T.u32, T.double, T.double, T.u32], returns: T.ptr },
      CGEventCreateScrollWheelEvent: { args: [T.ptr, T.u32, T.u32, T.i32], returns: T.ptr },
      CGEventSetType: { args: [T.ptr, T.u32], returns: T.void },
      CGEventSetFlags: { args: [T.ptr, T.u32], returns: T.void },
      CGEventSetIntegerValueField: { args: [T.ptr, T.u32, T.i64], returns: T.void },
      CGEventPost: { args: [T.u32, T.ptr], returns: T.void },
      CGEventSourceButtonState: { args: [T.u32, T.u32], returns: T.bool },
    });
    const cf = dlopen(CF_PATH, { CFRelease: { args: [T.ptr], returns: T.void } });
    return { cg: cg.symbols, cf: cf.symbols } as Symbols;
  }

  const koffi = await import("koffi");
  const cg = koffi.load(CG_PATH);
  const cf = koffi.load(CF_PATH);
  return {
    cg: {
      CGWarpMouseCursorPosition: cg.func("CGWarpMouseCursorPosition", "int32", ["double", "double"]),
      CGEventCreate: cg.func("CGEventCreate", "void *", ["void *"]),
      CGEventCreateMouseEvent: cg.func("CGEventCreateMouseEvent", "void *", ["void *", "uint32", "double", "double", "uint32"]),
      CGEventCreateScrollWheelEvent: cg.func("CGEventCreateScrollWheelEvent", "void *", ["void *", "uint32", "uint32", "int32"]),
      CGEventSetType: cg.func("CGEventSetType", "void", ["void *", "uint32"]),
      CGEventSetFlags: cg.func("CGEventSetFlags", "void", ["void *", "uint64"]),
      CGEventSetIntegerValueField: cg.func("CGEventSetIntegerValueField", "void", ["void *", "uint32", "int64"]),
      CGEventPost: cg.func("CGEventPost", "void", ["uint32", "void *"]),
      CGEventSourceButtonState: cg.func("CGEventSourceButtonState", "bool", ["uint32", "uint32"]),
    },
    cf: { CFRelease: cf.func("CFRelease", "void", ["void *"]) },
  };
}

export type MousePollers = {
  pollButtonState: () => boolean;
  pollMouseLocation: () => { x: number; y: number };
};

/** Readers used by scenario capture, initialized once before its polling loop. */
export async function createMousePollers(): Promise<MousePollers> {
  const { cg } = await syms();
  const koffi = await import("koffi");
  const locationLibrary = koffi.load(CG_PATH);
  const point = koffi.struct({ x: "double", y: "double" });
  const createEvent = locationLibrary.func("CGEventCreate", "void *", ["void *"]);
  const eventLocation = locationLibrary.func("CGEventGetLocation", point, ["void *"]);
  const release = koffi.load(CF_PATH).func("CFRelease", "void", ["void *"]);

  return {
    pollButtonState: () => Boolean(cg.CGEventSourceButtonState(1, 0)),
    pollMouseLocation: () => {
      const event = need(createEvent(null), "event");
      try {
        return eventLocation(event) as { x: number; y: number };
      } finally {
        release(event);
      }
    },
  };
}

// Bun FFI bindings have fixed arity, while this CoreGraphics function is
// variadic. Load the same symbol separately for its two-wheel form.
async function openScroll2(): Promise<Symbols["cg"]> {
  if (typeof Bun !== "undefined") {
    const { dlopen, FFIType: T } = await import("bun:ffi");
    return dlopen(CG_PATH, {
      CGEventCreateScrollWheelEvent: { args: [T.ptr, T.u32, T.u32, T.i32, T.i32], returns: T.ptr },
    }).symbols as Symbols["cg"];
  }
  const koffi = await import("koffi");
  const cg = koffi.load(CG_PATH);
  return {
    CGEventCreateScrollWheelEvent: cg.func(
      "CGEventCreateScrollWheelEvent", "void *", ["void *", "uint32", "uint32", "int32", "int32"],
    ),
  };
}

async function syms(): Promise<Symbols> {
  if (!lib) lib = await open();
  return lib;
}

function need(p: Pointer | null, what: string): Pointer {
  if (!p) throw new Error(`CoreGraphics refused to create the ${what}`);
  return p;
}

export async function warp(x: number, y: number): Promise<void> {
  const err = (await syms()).cg.CGWarpMouseCursorPosition(x, y);
  if (err !== 0) throw new Error(`CGWarpMouseCursorPosition failed (${err})`);
}

export async function click(count: number, x?: number, y?: number,
                            button: MouseButton = "left", modifiers: string[] = []): Promise<void> {
  const { cg, cf } = await syms();
  const at = x !== undefined && y !== undefined;
  if (at) await warp(x!, y!);
  const spec = {
    left: { down: LEFT_DOWN, up: LEFT_UP, number: 0 },
    right: { down: RIGHT_DOWN, up: RIGHT_UP, number: 1 },
    middle: { down: OTHER_DOWN, up: OTHER_UP, number: 2 },
  }[button];

  // With coordinates, build the event at that point. Without them, start from a
  // plain event, which already carries the cursor's current location, then set
  // its type and button number, so a bare `click` never invents a position.
  const event = at
    ? need(cg.CGEventCreateMouseEvent(null, spec.down, x!, y!, spec.number), "mouse event")
    : need(cg.CGEventCreate(null), "event");
  const flags = modifiers.reduce((mask, mod) => mask | (MODIFIER_FLAGS[mod] ?? 0), 0);

  for (let n = 1; n <= count; n++) {
    for (const type of [spec.down, spec.up]) {
      cg.CGEventSetType(event, type);
      cg.CGEventSetIntegerValueField(event, BUTTON_NUMBER, BigInt(spec.number));
      // Click state is what makes the second click register as a double click.
      cg.CGEventSetIntegerValueField(event, CLICK_STATE, BigInt(n));
      cg.CGEventSetFlags(event, flags);
      cg.CGEventPost(HID_TAP, event);
    }
  }
  cf.CFRelease(event);
}

export async function drag(fromX: number, fromY: number, toX: number, toY: number,
                           durationMs: number, steps: number): Promise<void> {
  const { cg, cf } = await syms();
  await warp(fromX, fromY);

  const post = (type: number, x: number, y: number) => {
    const event = need(cg.CGEventCreateMouseEvent(null, type, x, y, 0), "drag event");
    cg.CGEventPost(HID_TAP, event);
    cf.CFRelease(event);
  };

  post(LEFT_DOWN, fromX, fromY);
  for (let index = 1; index <= steps; index++) {
    await sleep(durationMs / steps);
    const progress = index / steps;
    post(LEFT_DRAGGED,
      fromX + (toX - fromX) * progress,
      fromY + (toY - fromY) * progress);
  }
  post(LEFT_UP, toX, toY);
}

export async function scroll(lines: number, axis: "vertical" | "horizontal" = "vertical"): Promise<void> {
  const { cg, cf } = await syms();
  const event = axis === "vertical"
    ? need(cg.CGEventCreateScrollWheelEvent(null, UNIT_LINE, 1, lines), "scroll event")
    : need((scroll2Lib ??= await openScroll2()).CGEventCreateScrollWheelEvent(
      null, UNIT_LINE, 2, 0, lines), "horizontal scroll event");
  cg.CGEventPost(HID_TAP, event);
  cf.CFRelease(event);
}
