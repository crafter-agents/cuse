import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function which(tool: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = resolve(directory || ".", tool);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Keep searching PATH.
    }
  }
  return null;
}
