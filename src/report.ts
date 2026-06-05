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
  tokens_cache_read: number;
  tokens_cache_write: number;
  tokens_total: number;
  turns: number;
  api_errors: number;
  session_html: string | undefined;
  session_htmls: string[];
  log_file: string | undefined;
  children: StageReport[];
}

interface RunHistoryEntry {
  id: string;
  dir: string;
  current: boolean;
  started_at: string;
  ended_at: string;
  status: string;
  mode: string;
  duration_ms: number;
  stages_total?: number;
  stages_completed?: number;
  stages_failed?: number;
  tools?: number;
  tokens_total?: number;
  model?: string;
  report_path?: string;
  log_path?: string;
  sessions_dir?: string;
}

function emptyRun(id: string, dir: string, current: boolean): RunHistoryEntry {
  return { id, dir, current, started_at: "", ended_at: "", status: "unknown", mode: current ? "current" : "archived", duration_ms: 0 };
}

export function collectRunHistory(workspace: Workspace, currentStages: StageReport[] = []): RunHistoryEntry[] {
  const entries: RunHistoryEntry[] = [];
  entries.push(applyCurrentStageMetrics(runEntry(workspace.engineDir, "Current run", true), currentStages));

  if (existsSync(workspace.runsDir)) {
    const dirs = globSync("*", { cwd: workspace.runsDir, onlyDirectories: true }).sort().reverse();
    for (const id of dirs) entries.push(runEntry(path.join(workspace.runsDir, id), id, false));
  }
  return entries;
}

function runEntry(dir: string, id: string, current: boolean): RunHistoryEntry {
  const entry = emptyRun(id, dir, current);
  const metaPath = path.join(dir, "run.yaml");
  if (existsSync(metaPath)) {
    try {
      const meta = yaml.load(readFileSync(metaPath, "utf-8")) as Record<string, any>;
      if (meta && typeof meta === "object") {
        entry.id = current ? "Current run" : String(meta.run_id ?? id);
        entry.started_at = String(meta.started_at ?? "");
        entry.ended_at = String(meta.ended_at ?? "");
        entry.status = String(meta.status ?? entry.status);
        if (!current && entry.status === "running") entry.status = "interrupted";
        entry.mode = String(meta.mode ?? entry.mode);
        entry.duration_ms = Number(meta.duration_ms ?? 0);
        entry.model = meta.model == null ? undefined : String(meta.model);
        entry.stages_total = numberOrUndefined(meta.stages_total);
        entry.stages_completed = numberOrUndefined(meta.stages_completed);
        entry.stages_failed = numberOrUndefined(meta.stages_failed);
        entry.tools = numberOrUndefined(meta.tools);
        entry.tokens_total = numberOrUndefined(meta.tokens_total);
      }
    } catch {
      // malformed metadata must not break report rendering
    }
  }
  const reportPath = path.join(dir, "flow-report.html");
  const logPath = path.join(dir, "youngflow.log");
  const sessionsDir = path.join(dir, "sessions");
  if (existsSync(reportPath)) entry.report_path = reportPath;
  if (existsSync(logPath)) entry.log_path = logPath;
  if (existsSync(sessionsDir)) entry.sessions_dir = sessionsDir;
  applyArchivedLogMetrics(entry);
  return entry;
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function applyCurrentStageMetrics(entry: RunHistoryEntry, stages: StageReport[]): RunHistoryEntry {
  if (stages.length === 0) return entry;
  entry.stages_total ??= stages.length;
  entry.stages_completed ??= stages.filter((s) => s.status === "success").length;
  entry.stages_failed ??= stages.filter((s) => s.status === "failed").length;
  entry.tools ??= stages.reduce((sum, s) => sum + s.tools, 0);
  entry.tokens_total ??= stages.reduce((sum, s) => sum + s.tokens_total, 0);
  return entry;
}

function applyArchivedLogMetrics(entry: RunHistoryEntry): void {
  const logsDir = path.join(entry.dir, "logs");
  if (!existsSync(logsDir)) return;
  const logs = globSync("*.log", { cwd: logsDir, absolute: true }).sort();
  if (logs.length === 0) return;

  let completed = 0;
  let failed = 0;
  let tools = 0;
  let tokensTotal = 0;
  for (const logFile of logs) {
    const content = readFileSync(logFile, "utf-8");
    const doneRe = /DONE: exit=(\d+) duration=(\d+)ms/g;
    let match: RegExpExecArray | null;
    let sawDone = false;
    let logFailed = false;
    while ((match = doneRe.exec(content)) !== null) {
      sawDone = true;
      if (parseInt(match[1]) !== 0) logFailed = true;
    }
    if (!sawDone) continue;
    if (logFailed) failed++;
    else completed++;
    tools += sumAll(/tools=(\d+)/g, content);
    tokensTotal += sumAll(/tokens_total=(\d+)/g, content);
  }

  const total = completed + failed;
  if (total > 0) {
    entry.stages_completed ??= completed;
    entry.stages_failed ??= failed;
    entry.stages_total ??= total;
  }
  if (tools > 0) entry.tools ??= tools;
  if (tokensTotal > 0) entry.tokens_total ??= tokensTotal;
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
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    tokens_total: 0,
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

    info.type = stage.type;
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
  info.tokens_cache_read = info.children.reduce((s, c) => s + c.tokens_cache_read, 0);
  info.tokens_cache_write = info.children.reduce((s, c) => s + c.tokens_cache_write, 0);
  info.tokens_total = info.children.reduce((s, c) => s + c.tokens_total, 0);
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
    result.tokens_cache_read = sumAll(/tokens_cache_read=(\d+)/g, content);
    result.tokens_cache_write = sumAll(/tokens_cache_write=(\d+)/g, content);
    result.tokens_total = sumAll(/tokens_total=(\d+)/g, content);
    const computedTotal = result.tokens_in + result.tokens_out + result.tokens_cache_read + result.tokens_cache_write;
    if (result.tokens_total <= 0 || result.tokens_total < computedTotal) result.tokens_total = computedTotal;
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
    const history = collectRunHistory(workspace, stages);
    return renderHtml(stages, history, workspace.root, workspace.reportPath, workspace.executionLogPath);
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

function renderRunHistory(history: RunHistoryEntry[], reportPath: string): string {
  const base = path.dirname(reportPath);
  const rows = history.map((r) => {
    const cls = r.current ? ' class="current"' : "";
    const reportLink = r.current
      ? `<span class="disabled-link">Current report</span>`
      : r.report_path
        ? `<a href="${esc(rel(r.report_path, base))}" aria-label="Open report for ${esc(r.id)}">Report</a>`
        : `<span class="disabled-link">Report unavailable</span>`;
    const logLink = r.log_path ? `<a href="${esc(rel(r.log_path, base))}" aria-label="Open log for ${esc(r.id)}">Log</a>` : "";
    const sessionsLink = r.sessions_dir ? `<a href="${esc(rel(r.sessions_dir, base))}" aria-label="Open sessions for ${esc(r.id)}">Sessions</a>` : "";
    const actions = [reportLink, logLink, sessionsLink].filter(Boolean).join(" ");
    return `<tr${cls}><td>${esc(r.current ? "Current" : r.id)}</td><td class="timestamp">${esc(fmtDate(r.started_at || r.id))}</td><td>${esc(r.mode)}</td><td>${statusPill(r.status)}</td><td class="num">${fmt(r.duration_ms)}</td><td class="num">${esc(fmtStages(r))}</td><td class="num">${esc(fmtCompactNumber(r.tokens_total))}</td><td class="num">${esc(fmtCompactNumber(r.tools))}</td><td class="num">${esc(fmtOptionalNumber(r.stages_failed))}</td><td>${esc(r.model ?? "—")}</td><td><span class="run-actions">${actions}</span></td></tr>`;
  }).join("");
  return `<section class="section-card run-history"><div class="section-header"><h2 class="section-title">Run History</h2><span class="section-hint">Current run plus archived .youngflow/runs entries</span></div><table class="run-ledger"><thead><tr><th scope="col">Run</th><th scope="col">Started</th><th scope="col">Mode</th><th scope="col">Status</th><th scope="col">Duration</th><th scope="col">Stages</th><th scope="col">Tokens</th><th scope="col">Tools</th><th scope="col">Failures</th><th scope="col">Model</th><th scope="col">Open</th></tr></thead><tbody>${rows}</tbody></table></section>`;
}

function fmtStages(entry: RunHistoryEntry): string {
  if (entry.stages_completed == null || entry.stages_total == null) return "—";
  return `${entry.stages_completed}/${entry.stages_total}`;
}

function fmtOptionalNumber(value: number | undefined): string {
  return value == null ? "—" : value.toLocaleString();
}

function fmtCompactNumber(value: number | undefined): string {
  if (value == null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return value.toLocaleString();
}

function statusPill(status: string): string {
  const safe = status || "unknown";
  const cls = safe === "success" ? "status-success" : safe === "failed" ? "status-failed" : safe === "running" || safe === "pending" ? "status-running" : "status-warning";
  return `<span class="status-pill ${cls}">${esc(safe)}</span>`;
}

function fmtDate(value: string): string {
  if (!value) return "—";
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
  const d = parseDt(value);
  return d ? d.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC") : value;
}

interface ExecutionWorker {
  id: string;
  status: string;
  duration_ms: number;
  tokens_total: number;
  tools: number;
  session_file?: string;
}

interface ExecutionStep {
  seq: number;
  stage: string;
  baseStage: string;
  type: string;
  status: string;
  duration_ms: number;
  tokens_total: number;
  tools: number;
  session_file?: string;
  workers: ExecutionWorker[];
  dispatch_count?: number;
  fork_group?: string;
}

function renderStaticGraph(stages: StageReport[]): string {
  const graphNodes: string[] = [];
  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const [icon, color] = STATUS[s.status] ?? ["⏳", "#555"];
    const dur = fmt(s.duration_ms);

    if ((s.type === "parallel" || s.type === "map") && s.children.length > 0) {
      const childHtml = s.children
        .map((c) => {
          const [ci, cc] = STATUS[c.status] ?? ["⏳", "#555"];
          return `<div class="graph-node" style="border-color:${cc}">${ci} ${esc(c.name)} <span style="color:#777">(${fmt(c.duration_ms)})</span></div>`;
        })
        .join("");
      graphNodes.push(`<div class="graph-parallel">${childHtml}</div>`);
    } else {
      graphNodes.push(`<div class="graph-node" style="border-color:${color}">${icon} ${esc(s.id)} <span style="color:#777">(${dur})</span></div>`);
    }
    if (i < stages.length - 1) graphNodes.push('<div class="graph-arrow">→</div>');
  }
  return `<section class="section-card"><div class="section-header"><h2 class="section-title">Flow Graph</h2></div><div class="graph">${graphNodes.join("")}</div></section>`;
}

function parseExecutionTimeline(executionLogPath: string, stages: StageReport[]): ExecutionStep[] {
  if (!existsSync(executionLogPath)) return [];
  const stageTypes = new Map(stages.map((s) => [s.id, s.type]));
  const steps: ExecutionStep[] = [];
  const active = new Map<string, ExecutionStep>();
  const pendingDispatch = new Map<string, ExecutionStep>();
  const pendingForkTargets = new Map<string, string>();
  let seq = 0;
  let forkSeq = 0;

  const lines = readFileSync(executionLogPath, "utf-8").split(/\r?\n/).filter((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    let event: Record<string, any>;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    const eventName = String(event.event ?? event.type ?? "");
    if (event.category === "engine" && eventName === "checkpoint_save") {
      const stage = String(event.stage ?? "");
      const step = active.get(stage);
      if (step && step.status === "running" && step.type === "join") step.status = "success";
      continue;
    }
    if (event.category !== "stage") continue;

    if (eventName === "route") {
      const targets: string[] = [];
      const from = String(event.stage ?? "");
      let j = i;
      while (j < lines.length) {
        try {
          const e = JSON.parse(lines[j]) as Record<string, any>;
          if (e.category !== "stage" || String(e.event ?? e.type ?? "") !== "route" || String(e.stage ?? "") !== from) break;
          if (e.target) targets.push(String(e.target));
          j++;
        } catch {
          break;
        }
      }
      const routedStep = active.get(from);
      if (routedStep && routedStep.status === "running" && routedStep.type === "join") {
        routedStep.status = "success";
      }
      if (targets.length > 1) {
        const group = `fork-${++forkSeq}`;
        for (const target of targets) pendingForkTargets.set(target, group);
      }
      i = Math.max(i, j - 1);
      continue;
    }

    if (eventName === "dispatch") {
      const stage = String(event.stage ?? "");
      const stageType = stageTypes.get(stage);
      const step = makeExecutionStep(++seq, stage, stage, stageType && stageType !== "single" ? stageType : "map", pendingForkTargets.get(stage));
      step.dispatch_count = numberOrUndefined(event.count);
      steps.push(step);
      active.set(stage, step);
      pendingDispatch.set(stage, step);
      pendingForkTargets.delete(stage);
      continue;
    }

    if (eventName === "stage_start") {
      const stage = String(event.stage ?? "");
      const { baseStage } = splitWorkerStage(stage);
      if (stage !== baseStage && pendingDispatch.has(baseStage)) continue;
      const step = makeExecutionStep(++seq, stage, baseStage, stageTypes.get(baseStage) ?? "single", pendingForkTargets.get(baseStage));
      steps.push(step);
      active.set(stage, step);
      pendingForkTargets.delete(baseStage);
      continue;
    }

    if (eventName === "stage_done") {
      const stage = String(event.stage ?? "");
      const { baseStage, workerId } = splitWorkerStage(stage);
      const status = Number(event.exit_code ?? 0) === 0 ? "success" : "failed";
      if (workerId && pendingDispatch.has(baseStage)) {
        const parent = pendingDispatch.get(baseStage)!;
        parent.workers.push({
          id: workerId,
          status,
          duration_ms: Number(event.duration_ms ?? 0),
          tokens_total: Number(event.tokens_total ?? 0),
          tools: Number(event.tools ?? 0),
          session_file: event.session_file ? String(event.session_file) : undefined,
        });
        parent.duration_ms = Math.max(parent.duration_ms, Number(event.duration_ms ?? 0));
        parent.tokens_total += Number(event.tokens_total ?? 0);
        parent.tools += Number(event.tools ?? 0);
        parent.status = parent.workers.some((w) => w.status === "failed") ? "failed" : "success";
        continue;
      }
      const step = active.get(stage) ?? active.get(baseStage);
      if (!step) continue;
      step.status = status;
      step.duration_ms = Number(event.duration_ms ?? 0);
      step.tokens_total = Number(event.tokens_total ?? 0);
      step.tools = Number(event.tools ?? 0);
      step.session_file = event.session_file ? String(event.session_file) : undefined;
    }
  }
  return steps;
}

function makeExecutionStep(seq: number, stage: string, baseStage: string, type: string, forkGroup?: string): ExecutionStep {
  return { seq, stage, baseStage, type, status: "running", duration_ms: 0, tokens_total: 0, tools: 0, workers: [], fork_group: forkGroup };
}

function splitWorkerStage(stage: string): { baseStage: string; workerId?: string } {
  const idx = stage.indexOf("/");
  if (idx < 0) return { baseStage: stage };
  return { baseStage: stage.slice(0, idx), workerId: stage.slice(idx + 1) };
}

function renderExecutionTimeline(steps: ExecutionStep[], reportPath: string): string {
  if (steps.length === 0) return "";
  const parts: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.fork_group) {
      const group = step.fork_group;
      const groupSteps: ExecutionStep[] = [];
      while (i < steps.length && steps[i].fork_group === group) groupSteps.push(steps[i++]);
      i--;
      parts.push(`<div class="exec-fork">${groupSteps.map((s) => `<div class="exec-fork-branch">${renderExecutionNode(s, reportPath)}</div>`).join("")}</div>`);
    } else {
      parts.push(renderExecutionNode(step, reportPath));
    }
    if (i < steps.length - 1) parts.push('<div class="exec-arrow">→</div>');
  }
  return `<section class="section-card"><div class="section-header"><h2 class="section-title">Execution Timeline</h2><span class="section-hint">Actual execution order with per-instance metrics. Scroll → for more.</span></div><div class="exec-timeline-wrapper"><div class="exec-timeline" tabindex="0" role="region" aria-label="Execution timeline">${parts.join("")}</div></div></section>`;
}

function renderExecutionNode(step: ExecutionStep, reportPath: string): string {
  const [icon] = STATUS[step.status] ?? ["⏳"];
  const isJoin = step.type === "join";
  const cls = `exec-node${step.status === "failed" ? " failed" : ""}${isJoin ? " join-node" : ""}`;
  const label = `${step.baseStage}, ${step.status}, ${fmt(step.duration_ms)}`;
  if (isJoin) {
    return `<div class="${cls}" role="group" aria-label="${esc(label)}"><div class="exec-node-header"><span class="exec-node-title">⏩ ${esc(step.baseStage)}</span></div></div>`;
  }
  const badge = step.workers.length > 0 || step.dispatch_count != null ? `${step.type} · ${step.dispatch_count ?? step.workers.length}` : step.type;
  const session = step.session_file ? `<div class="exec-node-session"><a class="link-chip" href="${esc(sessionHref(step.session_file, reportPath))}" aria-label="Open session for ${esc(step.stage)} execution ${step.seq}">📋 Session</a></div>` : "";
  const workers = step.workers.length > 0 ? renderExecutionWorkers(step, reportPath) : "";
  return `<div class="${cls}" role="group" aria-label="${esc(label)}"><div class="exec-node-header"><span class="exec-node-title">${icon} ${esc(step.baseStage)}</span><span class="exec-node-badge">${esc(badge)}</span></div><div class="exec-node-stats"><span><span class="value">${fmt(step.duration_ms)}</span> dur</span><span><span class="value">${step.tools.toLocaleString()}</span> tools</span><span><span class="value">${esc(fmtCompactNumber(step.tokens_total))}</span> tok</span></div>${session}${workers}</div>`;
}

function renderExecutionWorkers(step: ExecutionStep, reportPath: string): string {
  const failed = step.workers.filter((w) => w.status === "failed").length;
  const success = step.workers.filter((w) => w.status === "success").length;
  const open = failed > 0 || step.workers.length <= 6 ? " open" : "";
  const rows = step.workers.map((w) => {
    const [icon] = STATUS[w.status] ?? ["⏳"];
    const session = w.session_file ? `<a class="link-chip" href="${esc(sessionHref(w.session_file, reportPath))}" aria-label="Open session for ${esc(step.baseStage)} worker ${esc(w.id)}">📋</a>` : "";
    return `<div class="exec-worker-row${w.status === "failed" ? " worker-failed" : ""}"><span>${icon}</span><span class="exec-worker-name">${esc(w.id)}</span><span class="exec-worker-stat">${fmt(w.duration_ms)}</span>${session}</div>`;
  }).join("");
  return `<details class="exec-workers"${open}><summary>${step.workers.length} workers · ${success} success · ${failed} failed</summary><div class="exec-worker-list">${rows}</div></details>`;
}

function sessionHref(sessionFile: string, reportPath: string): string {
  const html = sessionFile.replace(/\.jsonl$/, ".html");
  return rel(existsSync(html) ? html : sessionFile, path.dirname(reportPath));
}

function renderHtml(
  stages: StageReport[],
  history: RunHistoryEntry[],
  root: string,
  reportPath: string,
  executionLogPath: string,
): string {
  mkdirSync(path.dirname(reportPath), { recursive: true });

  const totalDur = stages.reduce((s, st) => s + st.duration_ms, 0);
  const totalTools = stages.reduce((s, st) => s + st.tools, 0);
  const totalIn = stages.reduce((s, st) => s + st.tokens_in, 0);
  const totalOut = stages.reduce((s, st) => s + st.tokens_out, 0);
  const totalCacheRead = stages.reduce((s, st) => s + st.tokens_cache_read, 0);
  const totalCacheWrite = stages.reduce((s, st) => s + st.tokens_cache_write, 0);
  const totalTokens = stages.reduce((s, st) => s + st.tokens_total, 0);
  const completed = stages.filter((s) => s.status === "success").length;
  const failures = stages.filter((s) => s.status === "failed").length;
  const apiErrors = stages.reduce((s, st) => s + st.api_errors, 0);

  const executionSteps = parseExecutionTimeline(executionLogPath, stages);
  const executionSection = executionSteps.length > 0
    ? renderExecutionTimeline(executionSteps, reportPath)
    : renderStaticGraph(stages);

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
    const hasFailedChild = s.children.some((c) => c.status === "failed");
    const stageFailed = s.status === "failed" || hasFailedChild;
    if (s.children.length > 0) {
      const rows = s.children.map((c) => {
        const [ci] = STATUS[c.status] ?? ["⏳"];
        let sessionLinks = "";
        if (c.session_htmls.length > 1) {
          sessionLinks = c.session_htmls
            .map(
              (h, i) =>
                `<a class="session-link" href="${esc(rel(h, path.dirname(reportPath)))}">Session ${i + 1}</a>`,
            )
            .join(" ");
        } else if (c.session_html) {
          sessionLinks = `<a class="session-link" href="${esc(rel(c.session_html, path.dirname(reportPath)))}">Session</a>`;
        }
        return `<tr class="worker-row ${c.status === "failed" ? "worker-failed" : ""}"><td>${ci} ${esc(c.status)}</td><td>${esc(c.name)}</td><td class="num">${fmt(c.duration_ms)}</td><td class="num">${c.tools}</td><td class="num">${c.tokens_total.toLocaleString()}</td><td>${sessionLinks}</td></tr>`;
      });
      const detailsOpen = s.status === "failed" || hasFailedChild;
      const openAttr = detailsOpen ? " open" : "";
      children = `<details class="worker-details"${openAttr}><summary>Workers (${s.children.length}${hasFailedChild ? ", failures" : ""})</summary><div class="worker-table-wrap"><table class="worker-table"><thead><tr><th scope="col">Status</th><th scope="col">Worker</th><th scope="col">Duration</th><th scope="col">Tools</th><th scope="col">Tokens</th><th scope="col">Sessions</th></tr></thead><tbody>${rows.join("")}</tbody></table></div></details>`;
    }

    return `<div class="stage-card ${stageFailed ? "stage-failed" : ""}"><div class="stage-header"><span class="stage-title">${icon} ${esc(s.name)}</span><span class="stage-badge">${s.type}</span></div>${stageFailed ? `<div class="failure-note">This stage failed. Open log for details.</div>` : ""}<div class="stage-card-body">${stats}${session}${children}</div></div>`;
  });

  const content = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>YoungFlow Report</title>
<style>
:root{--yf-bg:#09090B;--yf-surface-1:#111114;--yf-surface-2:#17171C;--yf-surface-3:#1D1D24;--yf-border-subtle:rgba(255,255,255,.06);--yf-border:rgba(255,255,255,.10);--yf-border-strong:rgba(255,255,255,.18);--yf-text:#F4F4F5;--yf-text-secondary:#D4D4D8;--yf-text-muted:#A1A1AA;--yf-text-faint:#71717A;--yf-accent:#38BDF8;--yf-accent-soft:rgba(56,189,248,.12);--yf-success:#22C55E;--yf-success-soft:rgba(34,197,94,.12);--yf-danger:#F87171;--yf-danger-soft:rgba(248,113,113,.12);--yf-warning:#F59E0B;--yf-warning-soft:rgba(245,158,11,.12);--yf-pending:#A1A1AA;--yf-pending-soft:rgba(161,161,170,.12);--yf-radius-sm:6px;--yf-radius-md:10px;--yf-radius-lg:14px}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--yf-bg);color:var(--yf-text);font-size:13px;line-height:1.5;padding:24px}.report-shell{max-width:1440px;margin:0 auto}a{color:var(--yf-accent);text-decoration:none}a:hover{text-decoration:underline}a:focus-visible,summary:focus-visible{outline:2px solid var(--yf-accent);outline-offset:2px;border-radius:var(--yf-radius-sm)}.num,.metric-value{font-variant-numeric:tabular-nums}.timestamp{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
h1{font-size:22px;line-height:28px;font-weight:650}.report-header{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-bottom:20px}.report-subtitle{color:var(--yf-text-muted);margin-top:4px}.generated{color:var(--yf-text-muted);font-size:12px;text-align:right}.summary-panel,.section-card{background:var(--yf-surface-1);border:1px solid var(--yf-border);border-radius:var(--yf-radius-lg);margin-bottom:16px}.summary-panel{padding:16px}.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px}.metric-label{color:var(--yf-text-muted);font-size:12px}.metric-value{color:var(--yf-text);font-size:15px;font-weight:650}.section-card{overflow:hidden}.section-header{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:14px 16px;border-bottom:1px solid var(--yf-border-subtle)}.section-title{font-size:15px;line-height:22px;font-weight:650}.section-hint{color:var(--yf-text-muted);font-size:12px}.run-ledger{width:100%;border-collapse:collapse}.run-ledger th,.run-ledger td{padding:10px 12px;border-bottom:1px solid var(--yf-border-subtle);text-align:left;vertical-align:middle}.run-ledger th{color:var(--yf-text-muted);font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.02em}.run-ledger td{color:var(--yf-text-secondary)}.run-ledger tr.current{background:rgba(56,189,248,.06)}.run-actions{display:inline-flex;flex-wrap:wrap;gap:8px}.disabled-link{color:var(--yf-text-faint)}.status-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid currentColor}.status-success{color:var(--yf-success);background:var(--yf-success-soft)}.status-failed{color:var(--yf-danger);background:var(--yf-danger-soft)}.status-running,.status-pending{color:var(--yf-pending);background:var(--yf-pending-soft)}.status-warning{color:var(--yf-warning);background:var(--yf-warning-soft)}
.exec-timeline-wrapper{position:relative}.exec-timeline-wrapper::after{content:'';position:absolute;right:0;top:0;bottom:0;width:32px;background:linear-gradient(to right,transparent,var(--yf-surface-1));pointer-events:none;opacity:.8}.exec-timeline{display:flex;align-items:flex-start;gap:0;overflow-x:auto;padding:16px;scrollbar-width:thin;scrollbar-color:var(--yf-border-strong) transparent}.exec-timeline::-webkit-scrollbar{height:6px}.exec-timeline::-webkit-scrollbar-thumb{background:var(--yf-border-strong);border-radius:3px}.exec-arrow{display:flex;align-items:center;padding:0 4px;color:var(--yf-text-faint);font-size:14px;flex-shrink:0;align-self:center}.exec-node{flex-shrink:0;width:200px;background:var(--yf-surface-1);border:1px solid var(--yf-border);border-radius:var(--yf-radius-md);overflow:hidden}.exec-node.failed{border-color:rgba(248,113,113,.45)}.exec-node.join-node{width:100px;background:var(--yf-surface-2);border-style:dashed}.exec-node-header{padding:10px 12px 6px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px}.exec-node-title{font-size:13px;font-weight:650;line-height:18px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.exec-node-badge{flex-shrink:0;font-size:10px;padding:1px 6px;border-radius:999px;background:var(--yf-surface-3);color:var(--yf-text-muted);white-space:nowrap}.exec-node-stats{padding:0 12px 8px;display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--yf-text-muted)}.exec-node-stats .value{color:var(--yf-text-secondary);font-weight:600;font-variant-numeric:tabular-nums}.exec-node-session{display:block;padding:0 12px 10px}.link-chip{display:inline-block;color:var(--yf-accent);border:1px solid var(--yf-border);border-radius:999px;padding:2px 8px;font-size:12px}.exec-workers{border-top:1px solid var(--yf-border-subtle)}.exec-workers>summary{padding:8px 12px;cursor:pointer;font-size:12px;font-weight:600;color:var(--yf-text-secondary);background:var(--yf-surface-2);list-style:none}.exec-workers>summary::-webkit-details-marker{display:none}.exec-workers>summary::before{content:'▶ ';font-size:9px;color:var(--yf-text-faint)}.exec-workers[open]>summary::before{content:'▼ '}.exec-worker-list{max-height:240px;overflow-y:auto;scrollbar-width:thin;scrollbar-color:var(--yf-border-strong) transparent}.exec-worker-list::-webkit-scrollbar{width:4px}.exec-worker-list::-webkit-scrollbar-thumb{background:var(--yf-border-strong);border-radius:2px}.exec-worker-row{display:flex;align-items:center;gap:8px;padding:5px 12px;font-size:11px;border-top:1px solid var(--yf-border-subtle)}.exec-worker-row.worker-failed{background:var(--yf-danger-soft)}.exec-worker-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--yf-text)}.exec-worker-stat{color:var(--yf-text-muted);white-space:nowrap}.exec-fork{display:flex;flex-direction:column;gap:8px;flex-shrink:0;border-left:2px solid var(--yf-border);padding-left:8px;margin-left:-4px}.exec-fork-branch{display:flex;align-items:flex-start;gap:0}.graph{display:flex;align-items:center;gap:8px;overflow-x:auto;padding:14px 16px}.graph-node{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 10px;border-radius:999px;border:1px solid var(--yf-border);background:var(--yf-surface-2);white-space:nowrap}.graph-arrow{color:var(--yf-text-faint)}.graph-parallel{display:flex;flex-direction:column;gap:4px;border:1px dashed var(--yf-border);border-radius:8px;padding:8px}.stage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px;align-items:start}.stage-card{background:var(--yf-surface-1);border:1px solid var(--yf-border);border-radius:12px;padding:20px;max-height:520px;display:flex;flex-direction:column;overflow:hidden}.stage-card-body{flex:1;min-height:0;overflow-y:auto;padding-right:2px}.stage-card-body::-webkit-scrollbar,.worker-table-wrap::-webkit-scrollbar{width:4px;height:4px}.stage-card-body::-webkit-scrollbar-thumb,.worker-table-wrap::-webkit-scrollbar-thumb{background:var(--yf-border-strong);border-radius:2px}.stage-failed{border-color:var(--yf-danger);background:linear-gradient(0deg,var(--yf-danger-soft),transparent 45%),var(--yf-surface-1)}.failure-note{color:var(--yf-danger);margin-bottom:10px}.stage-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:12px;flex-shrink:0}.stage-title{font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stage-badge{font-size:11px;padding:2px 8px;border-radius:4px;background:var(--yf-surface-3);color:var(--yf-text-muted);flex-shrink:0}.stage-stats{display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--yf-text-muted)}.stage-stats .value{color:var(--yf-text);font-weight:500}.session-link{display:inline-block;margin-top:8px;color:var(--yf-accent);text-decoration:none;font-size:13px;border:1px solid var(--yf-border);border-radius:999px;padding:2px 8px}.worker-details{margin-top:12px;border:1px solid var(--yf-border-subtle);border-radius:var(--yf-radius-md);overflow:hidden}.worker-details>summary{cursor:pointer;padding:10px 12px;color:var(--yf-text-secondary);background:var(--yf-surface-2)}.worker-table-wrap{max-height:320px;overflow:auto}.worker-table{width:100%;min-width:520px;border-collapse:collapse}.worker-table th,.worker-table td{padding:8px 10px;border-top:1px solid var(--yf-border-subtle);text-align:left}.worker-table th{color:var(--yf-text-muted);font-size:11px;text-transform:uppercase}.worker-failed{background:var(--yf-danger-soft)}.gantt{padding:20px}.gantt-axis{position:relative;height:20px;margin-bottom:8px;margin-left:160px}.gantt-tick{position:absolute;font-size:11px;color:var(--yf-text-faint);transform:translateX(-50%)}.gantt-row{display:flex;align-items:center;height:28px}.gantt-label{width:160px;font-size:12px;color:var(--yf-text-muted);text-align:right;padding-right:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}.gantt-label-parent{cursor:pointer;color:var(--yf-text)}.gantt-label-child{font-size:11px;color:var(--yf-text-faint);padding-left:16px}.gantt-group>summary{list-style:none}.gantt-group>summary::-webkit-details-marker{display:none}.gantt-group>summary .gantt-label-parent::before{content:'▶ ';font-size:9px;color:var(--yf-text-faint)}.gantt-group[open]>summary .gantt-label-parent::before{content:'▼ ';font-size:9px;color:var(--yf-text-faint)}.gantt-track{flex:1;position:relative;height:18px;background:var(--yf-bg);border-radius:4px}.gantt-bar{position:absolute;height:100%;border-radius:4px;min-width:3px;opacity:.85}.gantt-bar:hover{opacity:1}@media (max-width:760px){body{padding:16px}.report-header{flex-direction:column}.generated{text-align:left}.exec-timeline{flex-direction:column;align-items:stretch;overflow-x:visible}.exec-node,.exec-node.join-node{width:100%}.exec-arrow{justify-content:center;padding:4px 0;transform:rotate(90deg)}.exec-fork{flex-direction:column;border-left:none;border-top:2px solid var(--yf-border);padding-left:0;padding-top:8px;margin-left:0}.stage-grid{grid-template-columns:1fr}.stage-card{max-height:none}.stage-card-body{overflow:visible}.worker-table-wrap{max-height:none}}
</style></head><body><div class="report-shell">
<header class="report-header"><div><h1>YoungFlow Report</h1><div class="report-subtitle">Output: ${esc(root)}</div></div><div class="generated">Generated ${esc(fmtDate(new Date().toISOString()))}</div></header>
<section class="summary-panel" aria-labelledby="current-run-title"><div class="section-header"><h2 id="current-run-title" class="section-title">Current Run</h2></div><div class="summary-grid"><div><div class="metric-label">Completion</div><div class="metric-value">${completed}/${stages.length} stages</div></div><div><div class="metric-label">Duration</div><div class="metric-value">${fmt(totalDur)}</div></div><div><div class="metric-label">Tools</div><div class="metric-value">${totalTools}</div></div><div><div class="metric-label">Tokens total</div><div class="metric-value">${totalTokens.toLocaleString()}</div></div><div><div class="metric-label">Failures</div><div class="metric-value">${failures}</div></div><div><div class="metric-label">API errors</div><div class="metric-value">${apiErrors}</div></div></div></section>
${renderRunHistory(history, reportPath)}
${executionSection}
<section class="section-card"><div class="section-header"><h2 class="section-title">Timeline</h2><span class="section-hint">Durations show observed wall time when start times are available.</span></div>${renderGantt(stages)}</section>
<section><div class="section-header"><h2 class="section-title">Stage Details</h2><span class="section-hint">Stage cards wrap horizontally; large worker lists scroll inside each card.</span></div><div class="stage-grid">
${cards.join("")}</div></section>
<div style="color:#555;font-size:12px;margin-top:32px">Output: ${esc(root)}</div>
</div></body></html>`;

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
