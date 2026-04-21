/**
 * Flow report: collect stage data + render HTML dashboard.
 *
 * Called by orchestrator after each stage (incremental refresh)
 * and by CLI after flow completion (final report).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import fg from "fast-glob";
const { globSync } = fg;
import path from "node:path";
import yaml from "js-yaml";
import { StageType, type FlowSpec } from "./spec.js";
import type { Workspace } from "./workspace.js";
import { logEvent, debug } from "./logger.js";

// ---------------------------------------------------------------------------
// Data collection
// ---------------------------------------------------------------------------

interface StageReport {
  id: string;
  name: string;
  type: string;
  status: string;
  started_at: string;
  duration_ms: number;
  tools: number;
  tokens_in: number;
  tokens_out: number;
  turns: number;
  api_errors: number;
  session_html: string | undefined;
  session_htmls: string[];
  log_file: string | undefined;
  children: StageReport[];
}

function emptyReport(id: string): StageReport {
  return {
    id,
    name: id,
    type: "single",
    status: "pending",
    started_at: "",
    duration_ms: 0,
    tools: 0,
    tokens_in: 0,
    tokens_out: 0,
    turns: 0,
    api_errors: 0,
    session_html: undefined,
    session_htmls: [],
    log_file: undefined,
    children: [],
  };
}

export function collectStageReports(
  spec: FlowSpec,
  workspace: Workspace,
): StageReport[] {
  const stages: StageReport[] = [];
  const checkpointDir = workspace.checkpointsDir;

  for (const stage of spec.stages) {
    const info: StageReport = {
      ...emptyReport(stage.id),
      name: stage.name,
      type: stage.type,
    };

    // Check checkpoint
    const doneFile = path.join(checkpointDir, `${stage.id}.done.yaml`);
    if (existsSync(doneFile)) {
      const ckpt = yaml.load(readFileSync(doneFile, "utf-8")) as Record<
        string,
        any
      >;
      info.status = ckpt.status ?? "success";
      info.duration_ms = ckpt.duration_ms ?? 0;
      info.started_at = ckpt.started_at ?? "";
    }

    if (stage.type === StageType.PARALLEL) {
      for (const task of stage.tasks) {
        const child = parseStageLog(workspace.logsDir, task.id);
        child.name = task.name;
        info.children.push(child);
      }
      aggregateChildren(info);
    } else if (stage.type === StageType.MAP) {
      const safePrefix = stage.id.replace(/\//g, "_");
      const childLogs = globSync(`${safePrefix}_*.log`, {
        cwd: workspace.logsDir,
      })
        .filter((f) => !f.endsWith(".events.jsonl"))
        .sort();

      if (childLogs.length > 0) {
        for (const logFile of childLogs) {
          const itemKey = logFile.replace(".log", "").slice(safePrefix.length + 1);
          const childStageId = `${stage.id}/${itemKey}`;
          const child = parseStageLog(workspace.logsDir, childStageId);
          child.name = itemKey;
          info.children.push(child);
        }
        aggregateChildren(info);
      } else {
        const parsed = parseStageLog(workspace.logsDir, stage.id);
        Object.assign(info, parsed);
        applyCheckpoint(info, doneFile);
      }
    } else {
      const parsed = parseStageLog(workspace.logsDir, stage.id);
      Object.assign(info, parsed);
      applyCheckpoint(info, doneFile);
    }

    stages.push(info);
  }
  return stages;
}

function aggregateChildren(info: StageReport): void {
  if (info.children.length === 0) return;
  info.duration_ms = Math.max(...info.children.map((c) => c.duration_ms));
  info.tools = info.children.reduce((s, c) => s + c.tools, 0);
  info.tokens_in = info.children.reduce((s, c) => s + c.tokens_in, 0);
  info.tokens_out = info.children.reduce((s, c) => s + c.tokens_out, 0);
  if (
    info.status === "pending" &&
    info.children.some((c) => c.status === "success")
  ) {
    info.status = "success";
  }
}

function applyCheckpoint(info: StageReport, doneFile: string): void {
  if (!existsSync(doneFile)) return;
  const ckpt = yaml.load(readFileSync(doneFile, "utf-8")) as Record<
    string,
    any
  >;
  if (info.status === "pending") info.status = ckpt.status ?? "success";
  if (ckpt.duration_ms) info.duration_ms = ckpt.duration_ms;
}

function parseStageLog(logsDir: string, stageId: string): StageReport {
  const safeId = stageId.replace(/\//g, "_");
  const logFile = path.join(logsDir, `${safeId}.log`);
  const result = emptyReport(stageId);
  result.log_file = existsSync(logFile) ? logFile : undefined;
  if (!existsSync(logFile)) return result;

  const content = readFileSync(logFile, "utf-8");

  // DONE lines
  const doneRe = /DONE: exit=(\d+) duration=(\d+)ms/g;
  let match: RegExpExecArray | null;
  const exitCodes: number[] = [];
  const durations: number[] = [];
  while ((match = doneRe.exec(content)) !== null) {
    exitCodes.push(parseInt(match[1]));
    durations.push(parseInt(match[2]));
  }
  if (exitCodes.length > 0) {
    result.status = exitCodes.every((c) => c === 0) ? "success" : "failed";
    result.duration_ms = Math.max(...durations);
    result.turns = sumAll(/turns=(\d+)/g, content);
    result.tools = sumAll(/tools=(\d+)/g, content);
    result.tokens_in = sumAll(/tokens_in=(\d+)/g, content);
    result.tokens_out = sumAll(/tokens_out=(\d+)/g, content);
    result.api_errors = sumAll(/api_errors=(\d+)/g, content);
  }

  // Session links (deduplicated)
  const seen = new Set<string>();
  const sessionRe = /Session: (.+\.jsonl)/g;
  while ((match = sessionRe.exec(content)) !== null) {
    const htmlPath = match[1].replace(".jsonl", ".html");
    if (existsSync(htmlPath) && !seen.has(htmlPath)) {
      seen.add(htmlPath);
      result.session_htmls.push(htmlPath);
    }
  }
  if (result.session_htmls.length > 0) {
    result.session_html = result.session_htmls[0];
  }

  // started_at
  const startedMatch = content.match(
    /started at (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/,
  );
  if (startedMatch) {
    result.started_at = startedMatch[1].replace(" ", "T");
  }

  return result;
}

function sumAll(re: RegExp, content: string): number {
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    total += parseInt(m[1]);
  }
  return total;
}

// ---------------------------------------------------------------------------
// Report refresh
// ---------------------------------------------------------------------------

export function refresh(
  spec: FlowSpec,
  workspace: Workspace,
): string | undefined {
  try {
    const stages = collectStageReports(spec, workspace);
    return renderHtml(stages, workspace.root, workspace.reportPath);
  } catch (e) {
    debug("report", "debug", "Report refresh failed: %s", e);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const STATUS: Record<string, [string, string]> = {
  success: ["✅", "#22c55e"],
  failed: ["❌", "#ef4444"],
  pending: ["⏳", "#a3a3a3"],
};

function fmt(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  return s < 60 ? `${s.toFixed(0)}s` : `${(s / 60).toFixed(1)}min`;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseDt(s: string): Date | undefined {
  if (!s) return undefined;
  try {
    const d = new Date(s);
    return isNaN(d.getTime()) ? undefined : d;
  } catch {
    return undefined;
  }
}

function renderGantt(stages: StageReport[]): string {
  const allTimes: Array<{ dt: Date; dur: number }> = [];
  for (const s of stages) {
    collectTimes(s, allTimes);
  }
  if (allTimes.length === 0) return "";

  const epoch = Math.min(...allTimes.map((t) => t.dt.getTime()));
  const totalMs = Math.max(
    ...allTimes.map((t) => t.dt.getTime() - epoch + t.dur),
  );
  if (totalMs <= 0) return "";

  const rows = stages.map((s) => renderGanttStage(s, epoch, totalMs));

  const tickCount = 5;
  const ticks: string[] = [];
  for (let i = 0; i <= tickCount; i++) {
    const ms = (totalMs * i) / tickCount;
    const pct = (i / tickCount) * 100;
    ticks.push(
      `<span class="gantt-tick" style="left:${pct.toFixed(1)}%">${fmt(Math.round(ms))}</span>`,
    );
  }

  return `<div class="gantt"><div class="gantt-axis">${ticks.join("")}</div>${rows.join("")}</div>`;
}

function collectTimes(
  stage: StageReport,
  out: Array<{ dt: Date; dur: number }>,
): void {
  const dt = parseDt(stage.started_at);
  if (dt && stage.duration_ms > 0) out.push({ dt, dur: stage.duration_ms });
  for (const c of stage.children) {
    const cdt = parseDt(c.started_at);
    if (cdt && c.duration_ms > 0) out.push({ dt: cdt, dur: c.duration_ms });
  }
}

function renderGanttStage(
  stage: StageReport,
  epoch: number,
  totalMs: number,
): string {
  const timedChildren = stage.children.filter(
    (c) => parseDt(c.started_at) && c.duration_ms > 0,
  );

  let parentBar = ganttBarHtml(stage, epoch, totalMs);

  if (timedChildren.length === 0) {
    return `<div class="gantt-row"><span class="gantt-label">${esc(stage.name)}</span><div class="gantt-track">${parentBar}</div></div>`;
  }

  if (!parentBar && timedChildren.length > 0) {
    const earliest = Math.min(
      ...timedChildren.map((c) => parseDt(c.started_at)!.getTime()),
    );
    const latestEnd = Math.max(
      ...timedChildren.map(
        (c) => parseDt(c.started_at)!.getTime() + c.duration_ms,
      ),
    );
    const inferred = {
      ...stage,
      started_at: new Date(earliest).toISOString().slice(0, 19),
      duration_ms: latestEnd - earliest,
    };
    parentBar = ganttBarHtml(inferred, epoch, totalMs);
  }

  const childRows = timedChildren
    .map((c) => {
      const bar = ganttBarHtml(c, epoch, totalMs, true);
      return `<div class="gantt-row"><span class="gantt-label gantt-label-child">${esc(c.name)}</span><div class="gantt-track">${bar}</div></div>`;
    })
    .join("");

  return `<details class="gantt-group"><summary class="gantt-row"><span class="gantt-label gantt-label-parent">${esc(stage.name)} (${timedChildren.length})</span><div class="gantt-track">${parentBar}</div></summary>${childRows}</details>`;
}

function ganttBarHtml(
  entry: StageReport,
  epoch: number,
  totalMs: number,
  child = false,
): string {
  const dt = parseDt(entry.started_at);
  if (!dt || entry.duration_ms <= 0) return "";
  const offsetMs = dt.getTime() - epoch;
  const leftPct = (offsetMs / totalMs) * 100;
  const widthPct = Math.max((entry.duration_ms / totalMs) * 100, 0.5);
  const [, color] = STATUS[entry.status] ?? ["", "#555"];
  const opacity = child ? "opacity:0.6;" : "";
  return `<div class="gantt-bar" style="left:${leftPct.toFixed(2)}%;width:${widthPct.toFixed(2)}%;background:${color};${opacity}" title="${esc(entry.name)}: ${fmt(entry.duration_ms)}"></div>`;
}

function renderHtml(
  stages: StageReport[],
  root: string,
  reportPath: string,
): string {
  mkdirSync(path.dirname(reportPath), { recursive: true });

  const totalDur = stages.reduce((s, st) => s + st.duration_ms, 0);
  const totalTools = stages.reduce((s, st) => s + st.tools, 0);
  const totalIn = stages.reduce((s, st) => s + st.tokens_in, 0);
  const totalOut = stages.reduce((s, st) => s + st.tokens_out, 0);
  const completed = stages.filter((s) => s.status === "success").length;

  // Graph
  const graphNodes: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const [icon, color] = STATUS[s.status] ?? ["⏳", "#555"];
    const dur = fmt(s.duration_ms);

    if (
      (s.type === "parallel" || s.type === "map") &&
      s.children.length > 0
    ) {
      const childHtml = s.children
        .map((c) => {
          const [ci, cc] = STATUS[c.status] ?? ["⏳", "#555"];
          return `<div class="graph-node" style="border-color:${cc}">${ci} ${c.name} <span style="color:#777">(${fmt(c.duration_ms)})</span></div>`;
        })
        .join("");
      graphNodes.push(`<div class="graph-parallel">${childHtml}</div>`);
    } else {
      graphNodes.push(
        `<div class="graph-node" style="border-color:${color}">${icon} ${s.id} <span style="color:#777">(${dur})</span></div>`,
      );
    }
    if (i < stages.length - 1) {
      graphNodes.push('<div class="graph-arrow">→</div>');
    }
  }

  // Stage cards
  const cards = stages.map((s) => {
    const [icon] = STATUS[s.status] ?? ["⏳"];
    const dur = fmt(s.duration_ms);
    let stats = `<div class="stage-stats"><div><span class="value">${dur}</span> duration</div><div><span class="value">${s.tools}</span> tools</div><div><span class="value">${s.tokens_in.toLocaleString()}</span> in</div><div><span class="value">${s.tokens_out.toLocaleString()}</span> out</div>`;
    if (s.api_errors) {
      stats += `<div style="color:#ef4444"><span class="value">${s.api_errors}</span> errors</div>`;
    }
    stats += "</div>";

    let session = "";
    if (s.session_htmls.length > 1) {
      const links = s.session_htmls
        .map(
          (h) =>
            `<a class="session-link" href="${esc(rel(h, path.dirname(reportPath)))}">\uD83D\uDCCB ${path.basename(path.dirname(path.dirname(h)))}</a>`,
        )
        .join(" ");
      session = `<div style="margin-top:8px">${links}</div>`;
    } else if (s.session_html) {
      const r = rel(s.session_html, path.dirname(reportPath));
      session = `<a class="session-link" href="${esc(r)}">📋 View Session</a>`;
    }

    let children = "";
    if (s.children.length > 0) {
      const rows = s.children.map((c) => {
        const [ci] = STATUS[c.status] ?? ["⏳"];
        let sessionLinks = "";
        if (c.session_htmls.length > 1) {
          sessionLinks = c.session_htmls
            .map(
              (h, i) =>
                `<a class="session-link" href="${esc(rel(h, path.dirname(reportPath)))}">\uD83D\uDCCB${i + 1}</a>`,
            )
            .join(" ");
          sessionLinks = `<span>${sessionLinks}</span>`;
        } else if (c.session_html) {
          sessionLinks = `<a class="session-link" href="${esc(rel(c.session_html, path.dirname(reportPath)))}">\uD83D\uDCCB</a>`;
        }
        let childStats = `<span class="child-stat">${fmt(c.duration_ms)}</span><span class="child-stat">${c.tools} tools</span>`;
        if (c.tokens_in || c.tokens_out) {
          childStats += `<span class="child-stat">${c.tokens_in.toLocaleString()} in</span><span class="child-stat">${c.tokens_out.toLocaleString()} out</span>`;
        }
        return `<div class="child"><span>${ci}</span><span class="child-name">${esc(c.name)}</span>${childStats}${sessionLinks}</div>`;
      });
      children = `<div class="children">${rows.join("")}</div>`;
    }

    return `<div class="stage-card"><div class="stage-header"><span class="stage-title">${icon} ${esc(s.name)}</span><span class="stage-badge">${s.type}</span></div>${stats}${session}${children}</div>`;
  });

  const content = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>YoungFlow Report</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0a;color:#e5e5e5;padding:24px}
h1{font-size:24px;margin-bottom:8px}
.summary{color:#a3a3a3;margin-bottom:24px;font-size:14px}
.summary span{color:#e5e5e5;font-weight:600}
.graph{display:flex;align-items:center;gap:8px;margin-bottom:32px;overflow-x:auto;padding:16px 0}
.graph-node{padding:8px 16px;border-radius:8px;font-size:13px;white-space:nowrap;border:1px solid #333}
.graph-arrow{color:#555;font-size:18px}
.graph-parallel{display:flex;flex-direction:column;gap:4px;border:1px dashed #333;border-radius:8px;padding:8px}
.stage-card{background:#171717;border:1px solid #262626;border-radius:12px;padding:20px;margin-bottom:16px}
.stage-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}
.stage-title{font-size:16px;font-weight:600}
.stage-badge{font-size:11px;padding:2px 8px;border-radius:4px;background:#262626;color:#a3a3a3}
.stage-stats{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:#a3a3a3}
.stage-stats .value{color:#e5e5e5;font-weight:500}
.session-link{display:inline-block;margin-top:8px;color:#60a5fa;text-decoration:none;font-size:13px}
.session-link:hover{text-decoration:underline}
.children{margin-top:12px;padding-left:16px;border-left:2px solid #262626}
.child{padding:8px 0;font-size:13px;display:flex;gap:16px;align-items:center}
.child-name{min-width:200px}
.child-stat{color:#a3a3a3}
.gantt{margin-bottom:32px;background:#171717;border:1px solid #262626;border-radius:12px;padding:20px}
.gantt-axis{position:relative;height:20px;margin-bottom:8px;margin-left:160px}
.gantt-tick{position:absolute;font-size:11px;color:#555;transform:translateX(-50%)}
.gantt-row{display:flex;align-items:center;height:28px}
.gantt-label{width:160px;font-size:12px;color:#a3a3a3;text-align:right;padding-right:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.gantt-label-parent{cursor:pointer;color:#e5e5e5}
.gantt-label-child{font-size:11px;color:#666;padding-left:16px}
.gantt-group>summary{list-style:none}
.gantt-group>summary::-webkit-details-marker{display:none}
.gantt-group>summary .gantt-label-parent::before{content:'▶ ';font-size:9px;color:#555}
.gantt-group[open]>summary .gantt-label-parent::before{content:'▼ ';font-size:9px;color:#555}
.gantt-track{flex:1;position:relative;height:18px;background:#0a0a0a;border-radius:4px}
.gantt-bar{position:absolute;height:100%;border-radius:4px;min-width:3px;opacity:0.85}
.gantt-bar:hover{opacity:1}
</style></head><body>
<h1>🔍 YoungFlow Report</h1>
<div class="summary">
<span>${completed}/${stages.length}</span> stages |
<span>${fmt(totalDur)}</span> total |
<span>${totalTools}</span> tools |
<span>${totalIn.toLocaleString()}</span> in |
<span>${totalOut.toLocaleString()}</span> out
</div>
<div class="graph">${graphNodes.join("")}</div>
${renderGantt(stages)}
${cards.join("")}
<div style="color:#555;font-size:12px;margin-top:32px">Output: ${esc(root)}</div>
</body></html>`;

  writeFileSync(reportPath, content, "utf-8");
  logEvent({ category: "engine", event: "report_refresh", path: reportPath });
  return reportPath;
}

function rel(filePath: string, baseDir: string): string {
  try {
    return path.relative(baseDir, filePath);
  } catch {
    return filePath;
  }
}
