import { describe, it, expect } from "vitest";
import { parseLiteral, compare, evaluateExpr } from "./condition.js";

// ---------------------------------------------------------------------------
// parseLiteral
// ---------------------------------------------------------------------------

describe("parseLiteral", () => {
  it("parses null/none", () => {
    expect(parseLiteral("null")).toBe(null);
    expect(parseLiteral("None")).toBe(null);
    expect(parseLiteral("NULL")).toBe(null);
  });

  it("parses booleans", () => {
    expect(parseLiteral("true")).toBe(true);
    expect(parseLiteral("True")).toBe(true);
    expect(parseLiteral("false")).toBe(false);
    expect(parseLiteral("False")).toBe(false);
  });

  it("parses integers", () => {
    expect(parseLiteral("0")).toBe(0);
    expect(parseLiteral("42")).toBe(42);
    expect(parseLiteral("-1")).toBe(-1);
  });

  it("parses floats", () => {
    expect(parseLiteral("3.14")).toBe(3.14);
    expect(parseLiteral("1e2")).toBe(100);
    expect(parseLiteral("1.0")).toBe(1.0);
  });

  it("returns string for non-numeric", () => {
    expect(parseLiteral("hello")).toBe("hello");
    expect(parseLiteral("")).toBe("");
    expect(parseLiteral("abc123")).toBe("abc123");
  });
});

// ---------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------

describe("compare", () => {
  it("handles null/undefined", () => {
    expect(compare(null, "==", null)).toBe(true);
    expect(compare(undefined, "==", null)).toBe(true);
    expect(compare(null, "!=", null)).toBe(false);
    expect(compare(null, "!=", 1)).toBe(true);
    expect(compare(null, ">", 0)).toBe(false);
  });

  it("equality", () => {
    expect(compare(1, "==", 1)).toBe(true);
    expect(compare("a", "==", "a")).toBe(true);
    expect(compare(true, "==", true)).toBe(true);
    expect(compare(1, "!=", 2)).toBe(true);
  });

  it("ordering", () => {
    expect(compare(5, ">", 3)).toBe(true);
    expect(compare(3, ">", 5)).toBe(false);
    expect(compare(5, ">=", 5)).toBe(true);
    expect(compare(3, "<", 5)).toBe(true);
    expect(compare(5, "<=", 5)).toBe(true);
  });

  it("contains_any", () => {
    expect(compare(["a", "b", "c"], "contains_any", "a,d")).toBe(true);
    expect(compare(["a", "b"], "contains_any", "x,y")).toBe(false);
    expect(compare("not_array", "contains_any", "a")).toBe(false);
  });

  it("not_contains_any", () => {
    expect(compare(["a", "b"], "not_contains_any", "x,y")).toBe(true);
    expect(compare(["a", "b"], "not_contains_any", "a,x")).toBe(false);
  });

  it("throws on unknown operator", () => {
    expect(() => compare(1, "~=", 1)).toThrow("Unsupported operator");
  });
});

// ---------------------------------------------------------------------------
// evaluateExpr
// ---------------------------------------------------------------------------

describe("evaluateExpr", () => {
  const vars: Record<string, unknown> = {
    count: 10,
    name: "hello",
    valid: true,
  };
  const getValue = (key: string) => {
    if (key in vars) return vars[key];
    throw new Error("not found");
  };

  it("evaluates basic expressions", () => {
    expect(evaluateExpr("count == 10", getValue)).toBe(true);
    expect(evaluateExpr("count > 5", getValue)).toBe(true);
    expect(evaluateExpr("name == hello", getValue)).toBe(true);
    expect(evaluateExpr("valid == true", getValue)).toBe(true);
  });

  it("handles missing keys as null", () => {
    expect(evaluateExpr("missing == null", getValue)).toBe(true);
    expect(evaluateExpr("missing != null", getValue)).toBe(false);
  });

  it("supports multi-word values", () => {
    const get = (k: string) => k === "msg" ? "hello world" : null;
    expect(evaluateExpr("msg == hello world", get)).toBe(true);
  });

  it("throws on malformed expressions", () => {
    expect(() => evaluateExpr("bad", getValue)).toThrow("Invalid condition");
    expect(() => evaluateExpr("a ==", getValue)).toThrow("Invalid condition");
  });
});
