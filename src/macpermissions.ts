import { dlopen, FFIType } from "bun:ffi";

function booleanSymbol(framework: string, symbol: string): boolean | null {
  try {
    const library = dlopen(`/System/Library/Frameworks/${framework}.framework/${framework}`, {
      [symbol]: { args: [], returns: FFIType.bool },
    });
    try {
      return Boolean(library.symbols[symbol]!());
    } finally {
      library.close();
    }
  } catch {
    return null;
  }
}

export type MacPermission = "screen-capture" | "accessibility";

/** Read the current TCC decision without requesting access or showing a prompt. */
export function readMacPermission(permission: MacPermission): boolean | null {
  return permission === "screen-capture"
    ? booleanSymbol("CoreGraphics", "CGPreflightScreenCaptureAccess")
    : booleanSymbol("ApplicationServices", "AXIsProcessTrusted");
}
