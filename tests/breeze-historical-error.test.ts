/// <reference types="bun-types" />
// TDD: Breeze rejects with a plain object (no `.message`), so the catch logged
// "Exception for MIDCPNIFTY on 2026-11-24: undefined" and shipped
// `warning: "Exception: undefined"` to callers.

import { describe, test, expect } from "bun:test";
import { describeError } from "@/lib/breeze-historical";

describe("describeError — never renders 'undefined'", () => {
  test("real Error keeps its message", () => {
    expect(describeError(new Error("boom"))).toBe("boom");
  });

  test("the Breeze-shaped plain object surfaces its Error field", () => {
    expect(describeError({ Error: "Invalid session", Status: 401 })).toBe(
      "Invalid session"
    );
  });

  test("a bare string is used as-is", () => {
    expect(describeError("socket hang up")).toBe("socket hang up");
  });

  test("undefined / null never produce the literal 'undefined'", () => {
    expect(describeError(undefined)).not.toBe("undefined");
    expect(describeError(undefined)).not.toContain("undefined");
    expect(describeError(null)).not.toContain("undefined");
  });

  test("message-less objects still yield something non-empty and non-undefined", () => {
    const out = describeError({ foo: 1 });
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("undefined");
  });

  test("empty message on an Error falls back rather than returning ''", () => {
    const out = describeError(new Error(""));
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain("undefined");
  });
});
