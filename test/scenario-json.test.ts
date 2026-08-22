import { describe, expect, test } from "bun:test";
import { parseJsonDocument } from "../src/scenario-json.ts";

describe("JSON document parsing", () => {
  test("parses one object with its source and encoded byte count", () => {
    const text = '{"message":"café"}';
    expect(parseJsonDocument(text, "stdout")).toEqual({
      ok: true,
      value: { message: "café" },
      source: "stdout",
      byteCount: new TextEncoder().encode(text).length,
    });
  });

  test.each(["", " \n\t "])("rejects empty input %#", (text) => {
    const result = parseJsonDocument(text, "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("empty");
  });

  test("rejects malformed JSON", () => {
    const result = parseJsonDocument('{"a":', "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("malformed");
  });

  test("rejects multiple JSON documents", () => {
    const result = parseJsonDocument('{"a":1}\n{"b":2}', "test");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("multiple_documents");
  });

  test("rejects oversized input before parsing", () => {
    const text = '{"message":"too long"}';
    expect(parseJsonDocument(text, "test", 10)).toEqual({
      ok: false,
      kind: "oversized",
      message: "JSON document exceeds the 10 byte limit",
      byteCount: new TextEncoder().encode(text).length,
    });
  });

  test.each([
    ["null", null],
    ["false", false],
    ["0", 0],
    ['""', ""],
  ] as const)("preserves the valid falsy value %s", (text, expected) => {
    const result = parseJsonDocument(text, "test");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(expected);
  });
});
