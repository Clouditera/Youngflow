import { describe, it, expect } from "vitest";
import { classifyError, ErrorKind, formatTool, formatToolArgs, loadEnvFile, Runner, defaultRunConfig } from "./runner.js";
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

  it("NON_RETRYABLE for DeepSeek reasoning_content replay protocol errors", () => {
    const r = result({
      exitCode: 1,
      finalStopReason: "error",
      lastError: "400 The `reasoning_content` in the thinking mode must be passed back to the API.",
    });
    expect(classifyError(r)).toBe(ErrorKind.NON_RETRYABLE);
  });
});

// ---------------------------------------------------------------------------
// Runner command construction
// ---------------------------------------------------------------------------

describe("Runner command construction", () => {
  it("passes thinking level with --thinking instead of model suffix", () => {
    const runner = new Runner({
      modelConfig: {
        modelString: "deepseek/deepseek-v4-pro",
        thinkingLevel: "medium",
        agentDir: "/tmp/.pi-agent",
        envVars: {},
      },
      engineConfig: {
        errorRetries: 0,
        errorRetryBackoff: 1,
        idleTimeout: 60,
        exportSessions: false,
      },
      systemPromptPath: "/tmp/system.md",
    });

    const cmd = (runner as any).buildCommand(defaultRunConfig({ task: "do it" })) as string[];
    expect(cmd).toContain("--model");
    expect(cmd[cmd.indexOf("--model") + 1]).toBe("deepseek/deepseek-v4-pro");
    expect(cmd).toContain("--thinking");
    expect(cmd[cmd.indexOf("--thinking") + 1]).toBe("medium");
    expect(cmd).not.toContain("deepseek/deepseek-v4-pro:medium");
  });

  it("passes explicit tools allowlist", () => {
    const runner = new Runner({
      modelConfig: {
        modelString: "zai/glm-5.1",
        agentDir: "/tmp/.pi-agent",
        envVars: {},
      },
      engineConfig: {
        errorRetries: 0,
        errorRetryBackoff: 1,
        idleTimeout: 60,
        exportSessions: false,
      },
      systemPromptPath: "/tmp/system.md",
    });

    const cmd = (runner as any).buildCommand(defaultRunConfig({ task: "do it", tools: ["read", "coverage"] })) as string[];
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("read,coverage");
  });

  it("passes explicit exclude tools denylist", () => {
    const runner = new Runner({
      modelConfig: {
        modelString: "zai/glm-5.1",
        agentDir: "/tmp/.pi-agent",
        envVars: {},
      },
      engineConfig: {
        errorRetries: 0,
        errorRetryBackoff: 1,
        idleTimeout: 60,
        exportSessions: false,
      },
      systemPromptPath: "/tmp/system.md",
    });

    const cmd = (runner as any).buildCommand(defaultRunConfig({ task: "do it", excludeTools: ["coverage", "bash"] })) as string[];
    expect(cmd[cmd.indexOf("--exclude-tools") + 1]).toBe("coverage,bash");
  });

  it("omits exclude tools flag when denylist is empty", () => {
    const runner = new Runner({
      modelConfig: {
        modelString: "zai/glm-5.1",
        agentDir: "/tmp/.pi-agent",
        envVars: {},
      },
      engineConfig: {
        errorRetries: 0,
        errorRetryBackoff: 1,
        idleTimeout: 60,
        exportSessions: false,
      },
      systemPromptPath: "/tmp/system.md",
    });

    const cmd = (runner as any).buildCommand(defaultRunConfig({ task: "do it", excludeTools: [] })) as string[];
    expect(cmd).not.toContain("--exclude-tools");
  });

  it("falls back to builtin tools when tools allowlist is empty", () => {
    const runner = new Runner({
      modelConfig: {
        modelString: "zai/glm-5.1",
        agentDir: "/tmp/.pi-agent",
        envVars: {},
      },
      engineConfig: {
        errorRetries: 0,
        errorRetryBackoff: 1,
        idleTimeout: 60,
        exportSessions: false,
      },
      systemPromptPath: "/tmp/system.md",
    });

    const cmd = (runner as any).buildCommand(defaultRunConfig({ task: "do it", tools: [] })) as string[];
    expect(cmd[cmd.indexOf("--tools") + 1]).toBe("read,bash,edit,write");
  });

  it("passes system prompt as a bare path so pi loads the file", () => {
    const runner = new Runner({
      modelConfig: {
        modelString: "zai/glm-5.1",
        agentDir: "/tmp/.pi-agent",
        envVars: {},
      },
      engineConfig: {
        errorRetries: 0,
        errorRetryBackoff: 1,
        idleTimeout: 60,
        exportSessions: false,
      },
      systemPromptPath: "/tmp/system.md",
    });

    const cmd = (runner as any).buildCommand(defaultRunConfig({ task: "do it" })) as string[];
    expect(cmd[cmd.indexOf("--system-prompt") + 1]).toBe("/tmp/system.md");
    expect(cmd).not.toContain("@/tmp/system.md");
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

describe("formatToolArgs", () => {
  it("formats read args without tool name", () => {
    expect(formatToolArgs("read", { path: "/f.ts", offset: 10, limit: 20 })).toBe(
      "/f.ts [10:30]",
    );
  });

  it("formats write/edit args without tool name", () => {
    expect(formatToolArgs("write", { path: "/a.ts" })).toBe("/a.ts");
    expect(formatToolArgs("edit", { path: "/a.ts" })).toBe("/a.ts");
  });

  it("formats bash args without tool name", () => {
    expect(formatToolArgs("bash", { command: "echo hi" })).toBe("echo hi");
  });

  it("returns empty args for unknown tools", () => {
    expect(formatToolArgs("my_tool", { foo: "bar" })).toBe("");
  });
});

// ---------------------------------------------------------------------------
// stringifyToolResult
// ---------------------------------------------------------------------------

describe("stringifyToolResult", () => {
  it("stringifies object tool error results", async () => {
    const mod = await import("./runner.js") as any;
    expect(mod.stringifyToolResult({ message: "bad write" })).toBe("bad write");
    expect(mod.stringifyToolResult({ code: "EIO" })).toBe('{"code":"EIO"}');
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
