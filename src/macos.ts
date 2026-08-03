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
import { dlopen, FFIType as T, type Pointer } from "bun:ffi";

const CG_PATH = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics";
const CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

const LEFT_DOWN = 1, LEFT_UP = 2, LEFT_DRAGGED = 6; // CGEventType
const CLICK_STATE = 1;              // CGEventField.kCGMouseEventClickState
const HID_TAP = 0;                  // CGEventTapLocation.kCGHIDEventTap
const UNIT_LINE = 1;                // CGScrollEventUnit.kCGScrollEventUnitLine

let lib: ReturnType<typeof open> | null = null;

function open() {
  const cg = dlopen(CG_PATH, {
    CGWarpMouseCursorPosition: { args: [T.double, T.double], returns: T.i32 },
    CGEventCreate: { args: [T.ptr], returns: T.ptr },
    CGEventCreateMouseEvent: { args: [T.ptr, T.u32, T.double, T.double, T.u32], returns: T.ptr },
    CGEventCreateScrollWheelEvent: { args: [T.ptr, T.u32, T.u32, T.i32], returns: T.ptr },
    CGEventSetType: { args: [T.ptr, T.u32], returns: T.void },
    CGEventSetIntegerValueField: { args: [T.ptr, T.u32, T.i64], returns: T.void },
    CGEventPost: { args: [T.u32, T.ptr], returns: T.void },
  });
  const cf = dlopen(CF_PATH, { CFRelease: { args: [T.ptr], returns: T.void } });
  return { cg: cg.symbols, cf: cf.symbols };
}

function syms() {
  if (!lib) lib = open();
  return lib;
}

function need(p: Pointer | null, what: string): Pointer {
  if (!p) throw new Error(`CoreGraphics refused to create the ${what}`);
  return p;
}

export function warp(x: number, y: number): void {
  const err = syms().cg.CGWarpMouseCursorPosition(x, y);
  if (err !== 0) throw new Error(`CGWarpMouseCursorPosition failed (${err})`);
}

export function click(count: number, x?: number, y?: number): void {
  const { cg, cf } = syms();
  const at = x !== undefined && y !== undefined;
  if (at) warp(x!, y!);

  // With coordinates, build the event at that point. Without them, start from a
  // plain event, which already carries the cursor's current location, and only
  // change its type - so a bare `click` never has to invent a position.
  const event = at
    ? need(cg.CGEventCreateMouseEvent(null, LEFT_DOWN, x!, y!, 0), "mouse event")
    : need(cg.CGEventCreate(null), "event");

  for (let n = 1; n <= count; n++) {
    for (const type of [LEFT_DOWN, LEFT_UP]) {
      cg.CGEventSetType(event, type);
      // Click state is what makes the second click register as a double click.
      cg.CGEventSetIntegerValueField(event, CLICK_STATE, BigInt(n));
      cg.CGEventPost(HID_TAP, event);
    }
  }
  cf.CFRelease(event);
}

export function drag(fromX: number, fromY: number, toX: number, toY: number): void {
  const { cg, cf } = syms();
  warp(fromX, fromY);

  const points: Array<[number, number, number]> = [
    [LEFT_DOWN, fromX, fromY],
    [LEFT_DRAGGED, (fromX + toX) / 2, (fromY + toY) / 2],
    [LEFT_DRAGGED, toX, toY],
    [LEFT_UP, toX, toY],
  ];
  for (const [type, x, y] of points) {
    const event = need(cg.CGEventCreateMouseEvent(null, type, x, y, 0), "drag event");
    cg.CGEventPost(HID_TAP, event);
    cf.CFRelease(event);
  }
}

export function scroll(lines: number): void {
  const { cg, cf } = syms();
  const event = need(cg.CGEventCreateScrollWheelEvent(null, UNIT_LINE, 1, lines), "scroll event");
  cg.CGEventPost(HID_TAP, event);
  cf.CFRelease(event);
}
