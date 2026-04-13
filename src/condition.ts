/**
 * Condition expression parsing and evaluation.
 *
 * Shared by state extraction (where clauses) and route evaluation.
 * Callers supply a getValue callback — this module is namespace-agnostic.
 */

export function parseLiteral(raw: string): unknown {
  const lower = raw.toLowerCase();
  if (lower === "null" || lower === "none") return null;
  if (lower === "true") return true;
  if (lower === "false") return false;

  // Match Python: int() then float() — accepts "1.0", "1e2", etc.
  const asNum = Number(raw);
  if (!Number.isNaN(asNum) && raw.trim() !== "") {
    return Number.isInteger(asNum) && !raw.includes(".") && !raw.includes("e") && !raw.includes("E")
      ? asNum   // int
      : asNum;  // float
  }

  return raw;
}

export function compare(actual: unknown, op: string, expected: unknown): boolean {
  if (actual === null || actual === undefined) {
    if (op === "==") return expected === null || expected === undefined;
    if (op === "!=") return expected !== null && expected !== undefined;
    return false;
  }

  // Set operators
  if (op === "contains_any" || op === "not_contains_any") {
    if (!Array.isArray(actual)) return false;
    const expectedSet = new Set(
      expected ? String(expected).split(",").map((v) => v.trim()) : [],
    );
    const actualSet = new Set(actual.map(String));
    const hasOverlap = [...actualSet].some((v) => expectedSet.has(v));
    return op === "contains_any" ? hasOverlap : !hasOverlap;
  }

  const ops: Record<string, (a: unknown, b: unknown) => boolean> = {
    "==": (a, b) => a == b,
    "!=": (a, b) => a != b,
    ">": (a, b) => (a as number) > (b as number),
    ">=": (a, b) => (a as number) >= (b as number),
    "<": (a, b) => (a as number) < (b as number),
    "<=": (a, b) => (a as number) <= (b as number),
  };

  const fn = ops[op];
  if (!fn) throw new Error(`Unsupported operator: '${op}'`);
  try {
    return fn(actual, expected);
  } catch {
    return false;
  }
}

export function evaluateExpr(
  expr: string,
  getValue: (key: string) => unknown,
): boolean {
  // Python split(None, 2): split into at most 3 parts, third part keeps remainder
  const trimmed = expr.trim();
  const m = trimmed.match(/^(\S+)\s+(\S+)\s+([\s\S]+)$/);
  if (!m) {
    throw new Error(`Invalid condition (expected 'key op value'): '${expr}'`);
  }

  const [, key, op, rawValue] = m;
  let actual: unknown;
  try {
    actual = getValue(key);
  } catch {
    actual = null;
  }

  const expected = parseLiteral(rawValue);
  return compare(actual, op, expected);
}
