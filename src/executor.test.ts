import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { StageEventLogger } from "./executor.js";

describe("StageEventLogger", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function tmpDir(): string {
    const d = path.join(os.tmpdir(), `youngflow-logger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpDirs.push(d);
    return d;
  }

  it("does not save raw event trace by default", () => {
    const dir = tmpDir();
    const logger = new StageEventLogger(dir, "stage/a");
    logger.onRawEvent('{"type":"turn_start"}');
    logger.close();

    expect(existsSync(path.join(dir, "stage_a.log"))).toBe(true);
    expect(existsSync(path.join(dir, "stage_a.events.jsonl"))).toBe(false);
  });

  it("saves raw event trace when enabled", () => {
    const dir = tmpDir();
    const logger = new StageEventLogger(dir, "stage/a", { traceEvents: true });
    logger.onRawEvent('{"type":"turn_start"}');
    logger.close();

    expect(existsSync(path.join(dir, "stage_a.log"))).toBe(true);
    expect(existsSync(path.join(dir, "stage_a.events.jsonl"))).toBe(true);
  });

  it("writes cache-aware token fields in done lines", () => {
    const dir = tmpDir();
    const logger = new StageEventLogger(dir, "stage/a");
    logger.onDone({
      exitCode: 0,
      durationMs: 123,
      toolCalls: ["read"],
      turns: 1,
      tokensIn: 10,
      tokensOut: 3,
      tokensCacheRead: 100,
      tokensCacheWrite: 5,
      tokensTotal: 118,
      apiErrors: 0,
      retries: 0,
      finalHasContent: true,
    });
    logger.close();

    const content = readFileSync(path.join(dir, "stage_a.log"), "utf-8");
    expect(content).toContain("tokens_in=10 tokens_out=3");
    expect(content).toContain("tokens_cache_read=100 tokens_cache_write=5 tokens_total=118");
  });
});
