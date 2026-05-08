import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  attachFileHandler,
  enableJsonLog,
  logEvent,
  LogLevel,
  resetLoggerForTest,
  setLevel,
} from "./logger.js";

describe("logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetLoggerForTest();
  });

  it("formats tool calls with tool name and args summary exactly once", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logEvent({
      category: "agent",
      event: "tool_call",
      stage: "enum-security",
      tool: "write",
      args_summary: ".../feature.yaml",
      elapsed_s: 703,
      status: "ok",
    });

    const output = String(write.mock.calls[0][0]);
    expect(output).toContain("[youngflow.runner] INFO [enum-security] [703s] write: .../feature.yaml");
    expect(output).not.toContain("write: write:");
  });

  it("formats tool calls without args summary", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logEvent({
      category: "agent",
      event: "tool_call",
      stage: "s1",
      tool: "unknown",
      args_summary: "",
      elapsed_s: 1,
      status: "ok",
    });

    expect(String(write.mock.calls[0][0])).toContain("[s1] [1s] unknown");
  });

  it("formats tool call errors", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    logEvent({
      category: "agent",
      event: "tool_call",
      stage: "s1",
      tool: "write",
      args_summary: "",
      elapsed_s: 2,
      status: "error",
      error_summary: "permission denied",
    });

    expect(String(write.mock.calls[0][0])).toContain(
      "[youngflow.runner] WARNING [s1] [2s] ❌ write: permission denied",
    );
  });

  it("emits structured NDJSON in json mode", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    enableJsonLog();

    logEvent({
      category: "engine",
      event: "flow_start",
      flow: "flow.yaml",
      work_dir: "/work",
      output_dir: "/out",
      model: "m",
      max_parallel: 2,
      resume: false,
    });

    const parsed = JSON.parse(String(write.mock.calls[0][0]));
    expect(parsed.event).toBe("flow_start");
    expect(parsed.output_dir).toBe("/out");
  });

  it("writes human-readable file logs", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const dir = mkdtempSync(path.join(os.tmpdir(), "youngflow-logger-"));
    const file = path.join(dir, "youngflow.log");
    attachFileHandler(file);

    logEvent({
      category: "engine",
      event: "flow_start",
      flow: "flow.yaml",
      work_dir: "/work",
      output_dir: "/out",
      model: "m",
      max_parallel: 2,
      resume: false,
    });

    const content = readFileSync(file, "utf-8");
    expect(content).toContain("[youngflow.flow] INFO flow_start: flow.yaml");
    expect(content).toContain("output_dir=/out");
    expect(write).toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it("filters stderr by level", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    setLevel(LogLevel.WARNING);

    logEvent({ category: "debug", event: "debug", source: "test", level: "info", message: "hidden" });
    logEvent({ category: "debug", event: "debug", source: "test", level: "warning", message: "shown" });

    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0][0])).toContain("shown");
  });
});
