async function booleanSymbol(framework: string, symbol: string): Promise<boolean | null> {
  const path = `/System/Library/Frameworks/${framework}.framework/${framework}`;
  try {
    if (typeof Bun !== "undefined") {
      const { dlopen, FFIType } = await import("bun:ffi");
      const library = dlopen(path, {
        [symbol]: { args: [], returns: FFIType.bool },
      });
      try {
        return Boolean(library.symbols[symbol]!());
      } finally {
        library.close();
      }
    }

    const koffi = await import("koffi");
    const library = koffi.load(path);
    try {
      return Boolean(library.func(symbol, "bool", [])());
    } finally {
      library.unload();
    }
  } catch {
    return null;
  }
}

export type MacPermission = "screen-capture" | "accessibility";

/** Read the current TCC decision without requesting access or showing a prompt. */
export function readMacPermission(permission: MacPermission): Promise<boolean | null> {
  return permission === "screen-capture"
    ? booleanSymbol("CoreGraphics", "CGPreflightScreenCaptureAccess")
    : booleanSymbol("ApplicationServices", "AXIsProcessTrusted");
}
