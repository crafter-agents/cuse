import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ScenarioValue } from "./scenario.ts";

export type ParsedJsonResult =
  | { ok: true; value: ScenarioValue; source: string; byteCount: number }
  | {
    ok: false;
    kind: "empty" | "malformed" | "multiple_documents" | "oversized" |
      "outside_root" | "not_found" | "not_file" | "read_error";
    message: string;
    byteCount: number;
  };

export const DEFAULT_MAX_JSON_BYTES = 65_536;

function failedFileResult(
  kind: "outside_root" | "not_found" | "not_file" | "read_error",
  message: string,
): ParsedJsonResult {
  return { ok: false, kind, message, byteCount: 0 };
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
}

export function readJsonFile(
  declaredPath: string,
  root: string,
  maxBytes: number = DEFAULT_MAX_JSON_BYTES,
): ParsedJsonResult {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    if (!statSync(realRoot).isDirectory()) {
      return failedFileResult("not_file", "Allowed root is not a directory");
    }
  } catch (error) {
    return failedFileResult("not_found", `Allowed root was not found: ${error instanceof Error ? error.message : String(error)}`);
  }

  const candidate = resolve(realRoot, declaredPath);
  if (!isInside(realRoot, candidate)) {
    return failedFileResult("outside_root", "JSON file path is outside the allowed root");
  }

  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failedFileResult("not_found", `JSON file was not found: ${declaredPath}`);
    }
    return failedFileResult("read_error", `Could not resolve JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!isInside(realRoot, realCandidate)) {
    return failedFileResult("outside_root", "JSON file path is outside the allowed root");
  }

  let descriptor: number | undefined;
  try {
    descriptor = openSync(realCandidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedFile = fstatSync(descriptor);
    if (!openedFile.isFile()) {
      return failedFileResult("not_file", `JSON path is not a file: ${declaredPath}`);
    }
    const pathAfterOpen = realpathSync(candidate);
    const fileAfterOpen = statSync(pathAfterOpen);
    if (!isInside(realRoot, pathAfterOpen) ||
      openedFile.dev !== fileAfterOpen.dev || openedFile.ino !== fileAfterOpen.ino) {
      return failedFileResult("outside_root", "JSON file path changed outside the allowed root while opening");
    }
    const text = readFileSync(descriptor, "utf8");
    return parseJsonDocument(text, declaredPath, maxBytes);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return failedFileResult("not_found", `JSON file was not found: ${declaredPath}`);
    }
    if (code === "EISDIR") {
      return failedFileResult("not_file", `JSON path is not a file: ${declaredPath}`);
    }
    return failedFileResult("read_error", `Could not read JSON file: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

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
