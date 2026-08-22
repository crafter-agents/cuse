import type { ScenarioValue } from "./scenario.ts";

// This pure parser is intentionally unwired and has no side effects.
// Nothing in the existing scenario runner calls it yet.

export type ParsedJsonResult =
  | { ok: true; value: ScenarioValue; source: string; byteCount: number }
  | {
    ok: false;
    kind: "empty" | "malformed" | "multiple_documents" | "oversized";
    message: string;
    byteCount: number;
  };

export const DEFAULT_MAX_JSON_BYTES = 65_536;

function classifyParseError(error: unknown): "malformed" | "multiple_documents" {
  return error instanceof SyntaxError && error.message.includes("after JSON at position")
    ? "multiple_documents"
    : "malformed";
}

function hasMultipleDocuments(text: string): boolean {
  for (let index = 1; index < text.length; index++) {
    if (!/\s/.test(text[index - 1]!) || !/\S/.test(text[index]!)) continue;

    try {
      JSON.parse(text.slice(0, index));
      JSON.parse(text.slice(index));
      return true;
    } catch {
      // Keep looking for a boundary between two independently valid documents.
    }
  }
  return false;
}

export function parseJsonDocument(
  text: string,
  source: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): ParsedJsonResult {
  const byteCount = new TextEncoder().encode(text).length;
  if (byteCount > maxBytes) {
    return {
      ok: false,
      kind: "oversized",
      message: `JSON document exceeds the ${maxBytes} byte limit`,
      byteCount,
    };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, kind: "empty", message: "JSON document is empty", byteCount };
  }

  try {
    const value = JSON.parse(trimmed) as ScenarioValue;
    return { ok: true, value, source, byteCount };
  } catch (error) {
    const kind = hasMultipleDocuments(trimmed)
      ? "multiple_documents"
      : classifyParseError(error);
    const message = kind === "multiple_documents"
      ? "Input contains more than one JSON document"
      : `Malformed JSON: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, kind, message, byteCount };
  }
}
