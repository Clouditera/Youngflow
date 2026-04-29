import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
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
});
