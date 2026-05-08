/**
 * Unified logging & event system for YoungFlow.
 *
 * Single interface: logEvent(event) — every log call is a typed event.
 *
 * Output modes (mutually exclusive on stderr):
 *   - Default:    human-readable text → stderr
 *   - --json-log: structured NDJSON   → stderr
 *
 * File log (.log) always receives human-readable text regardless of mode.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { formatDebugMessage, formatLogTime } from "./log-format.js";

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARNING = 30,
  ERROR = 40,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARNING]: "WARNING",
  [LogLevel.ERROR]: "ERROR",
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let globalLevel: LogLevel = LogLevel.INFO;
let logFilePath: string | undefined;
let jsonLogEnabled = false;

const FILE_LEVEL: LogLevel = LogLevel.DEBUG;

export function setLevel(level: LogLevel): void {
  globalLevel = level;
}

export function attachFileHandler(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  logFilePath = filePath;
}

export function enableJsonLog(): void {
  jsonLogEnabled = true;
}

export function resetLoggerForTest(): void {
  globalLevel = LogLevel.INFO;
  logFilePath = undefined;
  jsonLogEnabled = false;
}

// ---------------------------------------------------------------------------
// Event categories
// ---------------------------------------------------------------------------

export type EventCategory = "engine" | "stage" | "agent" | "debug";

// ---------------------------------------------------------------------------
// Engine events
// ---------------------------------------------------------------------------

export interface FlowStartEvent {
  category: "engine";
  event: "flow_start";
  flow: string;
  work_dir: string;
  output_dir: string;
  model: string;
  max_parallel: number;
  resume: boolean;
}

export interface FlowEndEvent {
  category: "engine";
  event: "flow_end";
  duration_ms: number;
  stages_total: number;
  stages_completed: number;
  stages_failed: number;
}

export interface CheckpointSaveEvent {
  category: "engine";
  event: "checkpoint_save";
  stage: string;
}

export interface CheckpointLoadEvent {
  category: "engine";
  event: "checkpoint_load";
  data: string;
}

export interface ReportRefreshEvent {
  category: "engine";
  event: "report_refresh";
  path: string;
}

// ---------------------------------------------------------------------------
// Stage events
// ---------------------------------------------------------------------------

export interface StageStartEvent {
  category: "stage";
  event: "stage_start";
  stage: string;
}

export interface StageDoneEvent {
  category: "stage";
  event: "stage_done";
  stage: string;
  exit_code: number;
  duration_ms: number;
  turns: number;
  tools: number;
  tokens_in: number;
  tokens_out: number;
  api_errors: number;
  retries: number;
  final_stop?: string;
}

export interface StageSkippedEvent {
  category: "stage";
  event: "stage_skipped";
  stage: string;
  reason: string;
}

export interface StageFailedEvent {
  category: "stage";
  event: "stage_failed";
  stage: string;
  exit_code: number;
}

export interface DispatchEvent {
  category: "stage";
  event: "dispatch";
  stage: string;
  count: number;
}

export interface RouteEvent {
  category: "stage";
  event: "route";
  stage: string;
  target: string | null;
}

export interface ProcessErrorEvent {
  category: "stage";
  event: "process_error";
  stage: string;
  error: string;
}

// ---------------------------------------------------------------------------
// Agent events
// ---------------------------------------------------------------------------

export interface ToolCallEvent {
  category: "agent";
  event: "tool_call";
  stage: string;
  tool: string;
  args_summary: string; // Arguments only; do not include the tool name.
  elapsed_s: number;
  status: "ok" | "error";
  error_summary?: string;
}

export interface ApiErrorEvent {
  category: "agent";
  event: "api_error";
  stage: string;
  error: string;
  api_errors_total: number;
}

export interface ExtensionErrorEvent {
  category: "agent";
  event: "extension_error";
  stage: string;
  message: string;
}

export interface AutoRetryEvent {
  category: "agent";
  event: "auto_retry";
  stage: string;
  attempt: number;
  max_attempts: number;
  delay_ms: number;
  reason: string;
}

export interface RetryEvent {
  category: "agent";
  event: "retry";
  stage: string;
  attempt: number;
  max_attempts: number;
  reason: string;
}

export interface IdleTimeoutEvent {
  category: "agent";
  event: "idle_timeout";
  stage: string;
  timeout_s: number;
}

export interface TimeoutEvent {
  category: "agent";
  event: "timeout";
  stage: string;
  timeout_s: number;
}

// ---------------------------------------------------------------------------
// Debug events (catch-all for informational messages)
// ---------------------------------------------------------------------------

export interface DebugEvent {
  category: "debug";
  event: "debug";
  source: string;
  level: "debug" | "info" | "warning" | "error";
  message: string;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type YoungFlowEvent =
  // engine
  | FlowStartEvent
  | FlowEndEvent
  | CheckpointSaveEvent
  | CheckpointLoadEvent
  | ReportRefreshEvent
  // stage
  | StageStartEvent
  | StageDoneEvent
  | StageSkippedEvent
  | StageFailedEvent
  | DispatchEvent
  | RouteEvent
  | ProcessErrorEvent
  // agent
  | ToolCallEvent
  | ApiErrorEvent
  | ExtensionErrorEvent
  | AutoRetryEvent
  | RetryEvent
  | IdleTimeoutEvent
  | TimeoutEvent
  // debug
  | DebugEvent;

// ---------------------------------------------------------------------------
// logEvent — single unified interface
// ---------------------------------------------------------------------------

export function logEvent(event: YoungFlowEvent): void {
  const ts = new Date().toISOString();
  const { module, level, text } = formatEvent(event);

  const tsShort = formatLogTime(new Date(ts));

  // stderr: JSON or text (mutually exclusive)
  if (jsonLogEnabled) {
    process.stderr.write(JSON.stringify({ ts, ...event }) + "\n");
  } else if (level >= globalLevel) {
    process.stderr.write(
      `${tsShort} [youngflow.${module}] ${LEVEL_NAMES[level]} ${text}\n`,
    );
  }

  // File log: always human-readable text
  if (logFilePath && level >= FILE_LEVEL) {
    try {
      appendFileSync(
        logFilePath,
        `${tsShort} [youngflow.${module}] ${LEVEL_NAMES[level]} ${text}\n`,
        "utf-8",
      );
    } catch {
      // best-effort
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: debug helper (replaces getLogger)
// ---------------------------------------------------------------------------

export function debug(source: string, level: "debug" | "info" | "warning" | "error", msg: string, ...args: unknown[]): void {
  const formatted = formatDebugMessage(msg, args);
  logEvent({ category: "debug", event: "debug", source, level, message: formatted });
}

export function logFlowMessage(message: string, opts: { stderr?: boolean } = {}): void {
  if (opts.stderr !== false) {
    process.stderr.write(message + "\n");
  }
  logEvent({ category: "debug", event: "debug", source: "flow", level: "info", message });
}

// ---------------------------------------------------------------------------
// Text formatting — produces human-readable text for each event type
// ---------------------------------------------------------------------------

interface FormattedEvent {
  module: string;
  level: LogLevel;
  text: string;
}

function formatEvent(event: YoungFlowEvent): FormattedEvent {
  switch (event.event) {
    // ── Engine ──
    case "flow_start":
      return {
        module: "flow",
        level: LogLevel.INFO,
        text:
          `flow_start: ${event.flow}` +
          ` | work_dir=${event.work_dir}` +
          ` | output_dir=${event.output_dir}` +
          ` | model=${event.model}` +
          ` | parallel=${event.max_parallel}` +
          (event.resume ? " | resume=true" : ""),
      };
    case "flow_end":
      return {
        module: "flow",
        level: LogLevel.INFO,
        text:
          `flow_end: ${event.duration_ms}ms` +
          ` | total=${event.stages_total}` +
          ` | completed=${event.stages_completed}` +
          ` | failed=${event.stages_failed}`,
      };
    case "checkpoint_save":
      return {
        module: "checkpoint",
        level: LogLevel.INFO,
        text: `Checkpoint: ${event.stage} marked done`,
      };
    case "checkpoint_load":
      return {
        module: "checkpoint",
        level: LogLevel.INFO,
        text: `Flow state loaded: ${event.data}`,
      };
    case "report_refresh":
      return {
        module: "report",
        level: LogLevel.INFO,
        text: `Flow report: ${event.path}`,
      };

    // ── Stage ──
    case "stage_start":
      return {
        module: "orchestrator",
        level: LogLevel.INFO,
        text: `[${event.stage}] starting`,
      };
    case "stage_done":
      return {
        module: "runner",
        level: event.exit_code === 0 ? LogLevel.INFO : LogLevel.WARNING,
        text:
          `[${event.stage}] DONE: exit=${event.exit_code}` +
          ` duration=${event.duration_ms}ms` +
          ` turns=${event.turns} tools=${event.tools}` +
          ` tokens_in=${event.tokens_in} tokens_out=${event.tokens_out}` +
          ` api_errors=${event.api_errors} retries=${event.retries}` +
          (event.final_stop ? ` final_stop=${event.final_stop}` : ""),
      };
    case "stage_skipped":
      return {
        module: "orchestrator",
        level: LogLevel.INFO,
        text: `[${event.stage}] skipped (${event.reason})`,
      };
    case "stage_failed":
      return {
        module: "orchestrator",
        level: LogLevel.ERROR,
        text: `[${event.stage}] FAILED (exit_code=${event.exit_code})`,
      };
    case "dispatch":
      return {
        module: "orchestrator",
        level: LogLevel.INFO,
        text: `[${event.stage}] dispatching ${event.count} items`,
      };
    case "route":
      return {
        module: "orchestrator",
        level: LogLevel.INFO,
        text: event.target
          ? `[${event.stage}] routing to '${event.target}'`
          : `[${event.stage}] no route matched → END`,
      };
    case "process_error":
      return {
        module: "runner",
        level: LogLevel.ERROR,
        text: `[${event.stage}] process error: ${event.error}`,
      };

    // ── Agent ──
    case "tool_call":
      if (event.status === "error") {
        return {
          module: "runner",
          level: LogLevel.WARNING,
          text: `[${event.stage}] [${event.elapsed_s}s] ❌ ${event.tool}: ${event.error_summary ?? ""}`,
        };
      }
      return {
        module: "runner",
        level: LogLevel.INFO,
        text: event.args_summary
          ? `[${event.stage}] [${event.elapsed_s}s] ${event.tool}: ${event.args_summary}`
          : `[${event.stage}] [${event.elapsed_s}s] ${event.tool}`,
      };
    case "api_error":
      return {
        module: "runner",
        level: LogLevel.ERROR,
        text: `[${event.stage}] ❌ API error (${event.api_errors_total}): ${event.error}`,
      };
    case "extension_error":
      return {
        module: "runner",
        level: LogLevel.WARNING,
        text: `[${event.stage}] ❌ extension: ${event.message}`,
      };
    case "auto_retry":
      return {
        module: "runner",
        level: LogLevel.WARNING,
        text:
          `[${event.stage}] 🔄 auto-retry ${event.attempt}/${event.max_attempts}` +
          ` in ${event.delay_ms}ms: ${event.reason}`,
      };
    case "retry":
      return {
        module: "runner",
        level: LogLevel.WARNING,
        text:
          `[${event.stage}] Retryable error (attempt ${event.attempt}/${event.max_attempts}):` +
          ` ${event.reason}`,
      };
    case "idle_timeout":
      return {
        module: "runner",
        level: LogLevel.WARNING,
        text: `[${event.stage}] No output for ${event.timeout_s}s, killing`,
      };
    case "timeout":
      return {
        module: "runner",
        level: LogLevel.ERROR,
        text: `[${event.stage}] Timeout after ${event.timeout_s}s`,
      };

    // ── Debug ──
    case "debug": {
      const lvl =
        event.level === "error" ? LogLevel.ERROR :
        event.level === "warning" ? LogLevel.WARNING :
        event.level === "debug" ? LogLevel.DEBUG :
        LogLevel.INFO;
      return { module: event.source, level: lvl, text: event.message };
    }
  }
}
