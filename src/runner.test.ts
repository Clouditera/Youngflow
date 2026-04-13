import { describe, it, expect } from "vitest";
import { classifyError, ErrorKind, formatTool, loadEnvFile } from "./runner.js";
import type { RunResult } from "./runner.js";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

function result(overrides: Partial<RunResult> = {}): RunResult {
  return {
    exitCode: 0,
    durationMs: 1000,
    toolCalls: [],
    turns: 1,
    tokensIn: 100,
    tokensOut: 50,
    apiErrors: 0,
    retries: 0,
    finalStopReason: "end_turn",
    finalHasContent: true,
    ...overrides,
  };
}

describe("classifyError", () => {
  it("SUCCESS: exit 0, good stop reason, has content", () => {
    expect(classifyError(result())).toBe(ErrorKind.SUCCESS);
  });

  it("TIMEOUT: exit -1", () => {
    expect(classifyError(result({ exitCode: -1 }))).toBe(ErrorKind.TIMEOUT);
  });

  it("not SUCCESS when finalStopReason is error", () => {
    const r = result({ finalStopReason: "error", lastError: "rate limit" });
    expect(classifyError(r)).not.toBe(ErrorKind.SUCCESS);
  });

  it("not SUCCESS when finalStopReason is null", () => {
    const r = result({ finalStopReason: undefined });
    expect(classifyError(r)).not.toBe(ErrorKind.SUCCESS);
  });

  it("not SUCCESS when no content", () => {
    const r = result({ finalHasContent: false });
    expect(classifyError(r)).toBe(ErrorKind.RETRYABLE);
  });

  it("NON_RETRYABLE for auth errors", () => {
    const r = result({ exitCode: 1, finalStopReason: "error", lastError: "invalid api key" });
    expect(classifyError(r)).toBe(ErrorKind.NON_RETRYABLE);
  });

  it("NON_RETRYABLE for context overflow", () => {
    const r = result({ exitCode: 1, finalStopReason: "error", lastError: "context length exceeded" });
    expect(classifyError(r)).toBe(ErrorKind.NON_RETRYABLE);
  });

  it("RETRYABLE for rate limit", () => {
    const r = result({ exitCode: 1, finalStopReason: "error", lastError: "rate limit exceeded" });
    expect(classifyError(r)).toBe(ErrorKind.RETRYABLE);
  });

  it("RETRYABLE for 529/overloaded", () => {
    const r = result({ exitCode: 1, finalStopReason: "error", lastError: "529 overloaded" });
    expect(classifyError(r)).toBe(ErrorKind.RETRYABLE);
  });

  it("RETRYABLE for Chinese error messages", () => {
    const r = result({ exitCode: 1, finalStopReason: "error", lastError: "负载较高，请稍后重试" });
    expect(classifyError(r)).toBe(ErrorKind.RETRYABLE);
  });
});

// ---------------------------------------------------------------------------
// formatTool
// ---------------------------------------------------------------------------

describe("formatTool", () => {
  it("formats read with path", () => {
    expect(formatTool("read", { path: "/a/b/c.ts" })).toBe("read: /a/b/c.ts");
  });

  it("formats read with offset/limit", () => {
    expect(formatTool("read", { path: "/f.ts", offset: 10, limit: 20 })).toBe(
      "read: /f.ts [10:30]",
    );
  });

  it("shortens long paths", () => {
    const long = "/a/b/c/d/e/f/g.ts";
    const formatted = formatTool("read", { path: long });
    expect(formatted).toContain("...");
    expect(formatted).toContain("g.ts");
  });

  it("formats bash with truncation", () => {
    const cmd = "x".repeat(150);
    const formatted = formatTool("bash", { command: cmd });
    expect(formatted.length).toBeLessThan(120);
    expect(formatted).toContain("...");
  });

  it("formats write/edit", () => {
    expect(formatTool("write", { path: "/a.ts" })).toBe("write: /a.ts");
    expect(formatTool("edit", { path: "/a.ts" })).toBe("edit: /a.ts");
  });

  it("returns tool name for unknown tools", () => {
    expect(formatTool("my_tool", { foo: "bar" })).toBe("my_tool");
  });
});

// ---------------------------------------------------------------------------
// loadEnvFile
// ---------------------------------------------------------------------------

describe("loadEnvFile", () => {
  const tmpDir = path.join(os.tmpdir(), `youngflow-test-${Date.now()}`);

  it("returns empty for missing file", () => {
    expect(loadEnvFile("/nonexistent/.env")).toEqual({});
    expect(loadEnvFile(undefined)).toEqual({});
  });

  it("parses env file", () => {
    mkdirSync(tmpDir, { recursive: true });
    const envPath = path.join(tmpDir, ".env");
    writeFileSync(envPath, [
      "# comment",
      "KEY1=value1",
      'KEY2="quoted value"',
      "KEY3='single quoted'",
      "",
      "EMPTY=",
    ].join("\n"));

    const env = loadEnvFile(envPath);
    expect(env.KEY1).toBe("value1");
    expect(env.KEY2).toBe("quoted value");
    expect(env.KEY3).toBe("single quoted");
    expect(env.EMPTY).toBeUndefined(); // empty value skipped

    rmSync(tmpDir, { recursive: true, force: true });
  });
});
