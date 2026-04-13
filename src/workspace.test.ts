import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Workspace } from "./workspace.js";
import { mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

describe("Workspace", () => {
  let tmpDir: string;
  let ws: Workspace;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `youngflow-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ws = new Workspace(tmpDir);
    ws.setup();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates .youngflow subdirectories on setup", () => {
    expect(existsSync(ws.sessionsDir)).toBe(true);
    expect(existsSync(ws.logsDir)).toBe(true);
    expect(existsSync(ws.checkpointsDir)).toBe(true);
  });

  it("root is the output directory", () => {
    expect(ws.root).toBe(tmpDir);
  });

  it("ensureDir creates subdirectories", () => {
    const dir = ws.ensureDir("profiler", "output");
    expect(existsSync(dir)).toBe(true);
    expect(dir).toBe(path.join(tmpDir, "profiler", "output"));
  });

  it("sessionPath generates timestamped paths", () => {
    const p = ws.sessionPath("profiler");
    expect(p).toContain("sessions");
    expect(p).toContain("profiler");
    expect(p).toMatch(/\.jsonl$/);
  });

  it("sessionPath with itemKey", () => {
    const p = ws.sessionPath("analyzer", "CVE-001");
    expect(p).toContain("analyzer");
    expect(p).toContain("CVE-001");
  });

  it("findFiles uses glob", () => {
    const subdir = path.join(tmpDir, "data");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, "a.yaml"), "x: 1");
    writeFileSync(path.join(subdir, "b.yaml"), "x: 2");
    writeFileSync(path.join(subdir, "c.txt"), "text");

    const yamlFiles = ws.findFiles("data/*.yaml");
    expect(yamlFiles).toHaveLength(2);
  });

  it("flowLog path", () => {
    expect(ws.flowLog).toContain(".youngflow");
    expect(ws.flowLog).toContain("youngflow.log");
  });

  it("reportPath", () => {
    expect(ws.reportPath).toContain("flow-report.html");
  });
});
