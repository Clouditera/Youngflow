import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Workspace } from "./workspace.js";
import { refresh } from "./report.js";

function spec(): any {
  return {
    stages: [{ id: "explorer", name: "Explorer", type: "single", tasks: [] }],
  };
}

describe("flow report run history", () => {
  let tmpDir: string;
  let ws: Workspace;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `youngflow-report-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    ws = new Workspace(tmpDir);
    ws.setup();
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("renders current and archived run history links", () => {
    writeFileSync(ws.runMetadataPath, "run_id: current\nmode: continue\nstatus: success\nstarted_at: '2026-05-12T12:00:00Z'\nduration_ms: 1000\nstages_completed: 1\nstages_total: 1\nstages_failed: 0\nmodel: zai/glm-5.1\n");
    const runDir = path.join(ws.runsDir, "20260512T110000Z");
    mkdirSync(path.join(runDir, "sessions"), { recursive: true });
    mkdirSync(path.join(runDir, "logs"), { recursive: true });
    writeFileSync(path.join(runDir, "run.yaml"), "run_id: 20260512T110000Z\nmode: normal\nstatus: success\nstarted_at: '2026-05-12T11:00:00Z'\nduration_ms: 2000\nstages_completed: 2\nstages_total: 3\nstages_failed: 1\nmodel: anthropic/test\n");
    writeFileSync(path.join(runDir, "logs", "a.log"), "DONE: exit=0 duration=10ms turns=1 tools=2 tokens_in=3 tokens_out=4 tokens_total=700 api_errors=0 retries=0 final_stop=end\n");
    writeFileSync(path.join(runDir, "logs", "b.log"), "DONE: exit=1 duration=20ms turns=1 tools=3 tokens_in=5 tokens_out=6 tokens_total=800 api_errors=0 retries=0 final_stop=error\n");
    writeFileSync(path.join(runDir, "flow-report.html"), "old report");
    writeFileSync(path.join(runDir, "youngflow.log"), "old log");

    const reportPath = refresh(spec(), ws)!;
    const html = readFileSync(reportPath, "utf-8");

    expect(html).toContain("Run History");
    expect(html).toContain("<h2 id=\"current-run-title\" class=\"section-title\">Current Run</h2>");
    expect(html).toContain("<th scope=\"col\">Run</th>");
    expect(html).toContain("<th scope=\"col\">Stages</th>");
    expect(html).toContain("<th scope=\"col\">Tokens</th>");
    expect(html).toContain("<th scope=\"col\">Tools</th>");
    expect(html).toContain("<th scope=\"col\">Failures</th>");
    expect(html).toContain("<th scope=\"col\">Model</th>");
    expect(html).toContain("Current");
    expect(html).toContain("20260512T110000Z");
    expect(html).toContain("runs/20260512T110000Z/flow-report.html");
    expect(html).toContain("runs/20260512T110000Z/youngflow.log");
    expect(html).toContain("runs/20260512T110000Z/sessions");
    expect(html).toContain("2/3");
    expect(html).toContain("1.5K");
    expect(html).toContain("5");
    expect(html).toContain("anthropic/test");
    expect(html).toContain("zai/glm-5.1");
  });

  it("renders execution timeline from execution jsonl and keeps static graph fallback", () => {
    const sessionDir = path.join(ws.sessionsDir, "alpha", "20260605-000000");
    mkdirSync(sessionDir, { recursive: true });
    const session = path.join(sessionDir, "session.jsonl");
    const sessionHtml = path.join(sessionDir, "session.html");
    writeFileSync(session, "{}\n");
    writeFileSync(sessionHtml, "<html>session</html>");
    writeFileSync(ws.executionLogPath, [
      { ts: "2026-06-05T00:00:00Z", category: "stage", event: "stage_start", stage: "alpha" },
      { ts: "2026-06-05T00:00:01Z", category: "stage", event: "stage_done", stage: "alpha", exit_code: 0, duration_ms: 1000, tools: 2, tokens_total: 126, session_file: session },
      { ts: "2026-06-05T00:00:02Z", category: "stage", event: "route", stage: "alpha", target: "beta" },
      { ts: "2026-06-05T00:00:03Z", category: "stage", event: "dispatch", stage: "beta", count: 2 },
      { ts: "2026-06-05T00:00:04Z", category: "stage", event: "stage_start", stage: "beta/ITEM-1", iterate_file: "/tmp/ITEM-1.yaml" },
      { ts: "2026-06-05T00:00:05Z", category: "stage", event: "stage_done", stage: "beta/ITEM-1", exit_code: 0, duration_ms: 2000, tools: 3, tokens_total: 200, session_file: session },
      { ts: "2026-06-05T00:00:06Z", category: "stage", event: "stage_start", stage: "beta/ITEM-2", iterate_file: "/tmp/ITEM-2.yaml" },
      { ts: "2026-06-05T00:00:07Z", category: "stage", event: "stage_done", stage: "beta/ITEM-2", exit_code: 1, duration_ms: 3000, tools: 4, tokens_total: 300, session_file: session },
      { ts: "2026-06-05T00:00:08Z", category: "stage", event: "route", stage: "beta", target: "joiner" },
      { ts: "2026-06-05T00:00:09Z", category: "stage", event: "stage_start", stage: "joiner" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const timelineSpec: any = { stages: [
      { id: "alpha", name: "Alpha", type: "single", tasks: [] },
      { id: "beta", name: "Beta", type: "map", tasks: [] },
      { id: "joiner", name: "Joiner", type: "join", tasks: [] },
    ] };

    const reportPath = refresh(timelineSpec, ws)!;
    const html = readFileSync(reportPath, "utf-8");

    expect(html).toContain("Execution Timeline");
    expect(html).not.toContain("<h2 class=\"section-title\">Flow Graph</h2>");
    expect(html).toContain("exec-node-title");
    expect(html).toContain("✅ alpha");
    expect(html).toContain("map · 2");
    expect(html).toContain("2 workers · 1 success · 1 failed");
    expect(html).toContain("exec-worker-row worker-failed");
    expect(html).toContain("⏩ joiner");
    expect(html).toContain("sessions/alpha/20260605-000000/session.html");
  });

  it("renders worker details as native details table and promotes child failures", () => {
    mkdirSync(path.join(ws.logsDir), { recursive: true });
    writeFileSync(path.join(ws.logsDir, "arguer_HYP-001.log"), "Stage: arguer/HYP-001 started at 2026-05-12 12:00:00\nDONE: exit=1 duration=10ms turns=1 tools=2 tokens_in=3 tokens_out=4 tokens_total=7 api_errors=0 retries=0 final_stop=error\n");
    writeFileSync(path.join(ws.logsDir, "arguer_HYP-002.log"), "Stage: arguer/HYP-002 started at 2026-05-12 12:00:00\nDONE: exit=0 duration=20ms turns=1 tools=1 tokens_in=3 tokens_out=4 tokens_total=7 api_errors=0 retries=0 final_stop=end_turn\n");
    const mapSpec: any = { stages: [{ id: "arguer", name: "Arguer", type: "map", tasks: [] }] };

    const reportPath = refresh(mapSpec, ws)!;
    const html = readFileSync(reportPath, "utf-8");

    expect(html).toContain("<div class=\"stage-grid\">");
    expect(html).toContain("<div class=\"stage-card-body\">");
    expect(html).toContain("<details class=\"worker-details\" open>");
    expect(html).toContain("<div class=\"worker-table-wrap\"><table class=\"worker-table\">");
    expect(html).toContain("<th scope=\"col\">Worker</th>");
    expect(html).toContain("This stage failed. Open log for details.");
    expect(html).toContain("worker-failed");
  });

  it("degrades when archived report is missing", () => {
    const runDir = path.join(ws.runsDir, "20260512T110000Z");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "run.yaml"), "status: failed\n");

    const reportPath = refresh(spec(), ws)!;
    const html = readFileSync(reportPath, "utf-8");

    expect(html).toContain("20260512T110000Z");
    expect(html).toContain("Report unavailable");
  });

  it("ignores malformed run metadata", () => {
    const runDir = path.join(ws.runsDir, "20260512T110000Z");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(path.join(runDir, "run.yaml"), ": bad: yaml:");

    expect(() => refresh(spec(), ws)).not.toThrow();
    const html = readFileSync(ws.reportPath, "utf-8");
    expect(html).toContain("20260512T110000Z");
  });
});
