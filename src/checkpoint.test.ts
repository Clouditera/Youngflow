import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Checkpoint } from "./checkpoint.js";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Checkpoint", () => {
  let tmpDir: string;
  let cp: Checkpoint;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `youngflow-ckpt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    cp = new Checkpoint(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- markDone / isDone ----

  it("marks stage as done and checks", () => {
    expect(cp.isDone("profiler")).toBe(false);
    cp.markDone("profiler", { exit_code: 0, duration_ms: 1000 });
    expect(cp.isDone("profiler")).toBe(true);
  });

  it("stores full result dict in checkpoint", () => {
    cp.markDone("profiler", {
      id: "profiler",
      exit_code: 0,
      duration_ms: 5000,
      output_dir: "/out/profiler",
      session_file: "/sessions/profiler.jsonl",
      started_at: "2024-01-01T00:00:00",
    });
    const loaded = cp.loadDone("profiler");
    expect(loaded.id).toBe("profiler");
    expect(loaded.exit_code).toBe(0);
    expect(loaded.duration_ms).toBe(5000);
    expect(loaded.output_dir).toBe("/out/profiler");
    expect(loaded.session_file).toBe("/sessions/profiler.jsonl");
  });

  // ---- worker-level checkpoints (subdirectory) ----

  it("supports worker-level checkpoint with slash in stageId", () => {
    const workerKey = "enumerators/find-bugs";
    cp.markDone(workerKey, { exit_code: 0, duration_ms: 2000, id: workerKey });
    expect(cp.isDone(workerKey)).toBe(true);

    const loaded = cp.loadDone(workerKey);
    expect(loaded.exit_code).toBe(0);
    expect(loaded.id).toBe(workerKey);

    // Verify file is in subdirectory
    expect(existsSync(path.join(tmpDir, "enumerators", "find-bugs.done.yaml"))).toBe(true);
  });

  // ---- loadDone strips metadata ----

  it("loadDone strips checkpoint metadata", () => {
    cp.markDone("s1", { exit_code: 0, duration_ms: 100 });
    const loaded = cp.loadDone("s1");
    expect(loaded).not.toHaveProperty("stage");
    expect(loaded).not.toHaveProperty("status");
    expect(loaded).not.toHaveProperty("completed_at");
    expect(loaded.exit_code).toBe(0);
  });

  it("loadDone returns empty for missing", () => {
    expect(cp.loadDone("nonexistent")).toEqual({});
  });

  // ---- completedStages ----

  it("lists completed stages", () => {
    cp.markDone("a", { exit_code: 0 });
    cp.markDone("b", { exit_code: 1 });
    const completed = cp.completedStages();
    expect(completed).toContain("a");
    expect(completed).toContain("b");
  });

  // ---- saveState / loadState ----

  it("saves and loads flow state", () => {
    const state = {
      extracted: { profiler: { is_valid: true } },
      route_counts: { "a→b": 1 },
      fork_context: { origin: "discovery", expected: ["research", "argument"], done: ["research"] },
      _route_targets: ["b"],       // should be excluded
      stage_results: [{ id: "a" }], // should be excluded
    };
    cp.saveState(state);
    const loaded = cp.loadState();
    expect(loaded.extracted).toEqual({ profiler: { is_valid: true } });
    expect(loaded.route_counts).toEqual({ "a→b": 1 });
    expect(loaded.fork_context).toEqual({ origin: "discovery", expected: ["research", "argument"], done: ["research"] });
    expect(loaded).not.toHaveProperty("_route_targets");
    expect(loaded).not.toHaveProperty("stage_results");
  });

  it("loadState returns empty for missing", () => {
    expect(cp.loadState()).toEqual({});
  });

  // ---- clean ----

  it("cleans all checkpoints", () => {
    cp.markDone("x", { exit_code: 0 });
    cp.saveState({ extracted: {} });
    cp.clean();
    expect(cp.isDone("x")).toBe(false);
    expect(cp.loadState()).toEqual({});
  });
});
