import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Workspace } from "./workspace.js";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
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

  it("archives only active engine entries and preserves business artifacts", () => {
    mkdirSync(path.join(tmpDir, "knowledge"), { recursive: true });
    writeFileSync(path.join(tmpDir, "knowledge", "profile.yaml"), "name: demo\n");
    writeFileSync(ws.runMetadataPath, "run_id: old\n");
    writeFileSync(ws.reportPath, "<html>old</html>");
    writeFileSync(ws.flowLog, "old log");
    writeFileSync(path.join(ws.checkpointsDir, "stage.done.yaml"), "status: success\n");
    writeFileSync(path.join(ws.logsDir, "stage.log"), "DONE: exit=0 duration=1ms\n");
    writeFileSync(path.join(ws.sessionsDir, "session.jsonl"), "{}\n");
    mkdirSync(path.join(ws.runsDir, "existing"), { recursive: true });
    writeFileSync(path.join(ws.runsDir, "existing", "flow-report.html"), "existing");

    const archiveDir = ws.archiveActiveRun("20260512T123456Z");

    expect(archiveDir).toBe(path.join(ws.runsDir, "20260512T123456Z"));
    expect(existsSync(path.join(archiveDir!, "run.yaml"))).toBe(true);
    expect(existsSync(path.join(archiveDir!, "flow-report.html"))).toBe(true);
    expect(existsSync(path.join(archiveDir!, "youngflow.log"))).toBe(true);
    expect(existsSync(path.join(archiveDir!, "checkpoints", "stage.done.yaml"))).toBe(true);
    expect(existsSync(path.join(archiveDir!, "logs", "stage.log"))).toBe(true);
    expect(existsSync(path.join(archiveDir!, "sessions", "session.jsonl"))).toBe(true);
    expect(existsSync(path.join(ws.runsDir, "existing", "flow-report.html"))).toBe(true);
    expect(readFileSync(path.join(tmpDir, "knowledge", "profile.yaml"), "utf-8")).toBe("name: demo\n");
    expect(existsSync(ws.checkpointsDir)).toBe(false);

    ws.setup();
    expect(existsSync(ws.checkpointsDir)).toBe(true);
    expect(existsSync(ws.logsDir)).toBe(true);
    expect(existsSync(ws.sessionsDir)).toBe(true);
  });

  it("returns undefined when no active engine entries exist", () => {
    rmSync(ws.checkpointsDir, { recursive: true, force: true });
    rmSync(ws.logsDir, { recursive: true, force: true });
    rmSync(ws.sessionsDir, { recursive: true, force: true });
    mkdirSync(path.join(ws.runsDir, "old"), { recursive: true });

    expect(ws.archiveActiveRun("new")).toBeUndefined();
    expect(existsSync(path.join(ws.runsDir, "old"))).toBe(true);
    expect(existsSync(path.join(ws.runsDir, "new"))).toBe(false);
  });
});
