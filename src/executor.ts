/**
 * Stage executor: translate a StageSpec into a pi CLI invocation.
 *
 * Single responsibility: stage spec + runtime context → run → StageResult.
 * No knowledge of execution order, graphs, or checkpoints.
 */

import { mkdirSync, appendFileSync, existsSync, statSync, openSync, writeSync, closeSync } from "node:fs";
import path from "node:path";

const RAW_EVENT_MAX_BYTES = 64 * 1024;
const UPDATE_EVENT_MAX_BYTES = 16 * 1024;
const MAX_STRING_CHARS = 4096;
const MAX_ARRAY_ITEMS = 8;
const MAX_OBJECT_KEYS = 40;

import { render, substituteVars, type PromptContext } from "./prompt.js";
import {
  type EventHandler,
  type RunConfig,
  type RunResult,
  Runner,
  formatToolCallDisplay,
} from "./runner.js";

import type { FlowSpec, StageSpec, TaskSpec } from "./spec.js";
import { resolveAgent } from "./spec.js";
import { Workspace } from "./workspace.js";

// ---------------------------------------------------------------------------
// StageResult
// ---------------------------------------------------------------------------

export interface StageResult {
  stageId: string;
  exitCode: number;
  durationMs: number;
  outputDir: string;
  sessionFile?: string;
}

// ---------------------------------------------------------------------------
// StageEventLogger
// ---------------------------------------------------------------------------

export class StageEventLogger implements EventHandler {
  private logFd: number;
  private eventsFd?: number;

  constructor(
    logsDir: string,
    stageId: string,
    opts: { traceEvents?: boolean } = {},
  ) {
    const safeId = stageId.replace(/\//g, "_");
    mkdirSync(logsDir, { recursive: true });
    const logPath = path.join(logsDir, `${safeId}.log`);
    const eventsPath = path.join(logsDir, `${safeId}.events.jsonl`);
    this.logFd = openSync(logPath, "a");
    if (opts.traceEvents) {
      this.eventsFd = openSync(eventsPath, "a");
    }
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);
    this.writeLog(`\n${"=".repeat(60)}`);
    this.writeLog(`Stage: ${stageId} started at ${now}`);
    this.writeLog("=".repeat(60));
  }

  onTurnStart(turn: number, _elapsedS: number): void {
    this.writeLog(`--- turn ${turn} ---`);
  }

  onToolStart(
    toolName: string,
    args: Record<string, any>,
    elapsedS: number,
  ): void {
    this.writeLog(`  [${elapsedS.toFixed(0)}s] ${formatToolCallDisplay(toolName, args)}`);

  }

  onToolEnd(
    toolName: string,
    isError: boolean,
    result: string,
    elapsedS: number,
  ): void {
    if (isError) {
      this.writeLog(`  [${elapsedS.toFixed(0)}s] ❌ ${toolName}: ${result}`);
    }
  }

  onMessageEnd(
    content: any[],
    usage: Record<string, number>,
    elapsedS: number,
  ): void {
    const inTok = usage.input ?? 0;
    const outTok = usage.output ?? 0;
    if (!content.length && inTok === 0 && outTok === 0) {
      this.writeLog(`  [${elapsedS.toFixed(0)}s] ⚠️ empty response`);
    } else if (inTok || outTok) {
      const textLen = content
        .filter((c: any) => c.type === "text")
        .reduce((sum: number, c: any) => sum + (c.text?.length ?? 0), 0);
      const thinkLen = content
        .filter((c: any) => c.type === "thinking")
        .reduce(
          (sum: number, c: any) => sum + (c.thinking?.length ?? 0),
          0,
        );
      this.writeLog(
        `  [${elapsedS.toFixed(0)}s] assistant: ${textLen}ch text, ${thinkLen}ch think (in=${inTok} out=${outTok})`,
      );
    }
  }

  onRawEvent(line: string): void {
    if (this.eventsFd == null) return;
    const eventLine = compactEventLine(line);
    const buf = Buffer.from(eventLine + "\n", "utf-8");
    writeSync(this.eventsFd, buf);
  }

  onDone(result: RunResult): void {
    this.writeLog(
      `DONE: exit=${result.exitCode} duration=${result.durationMs}ms ` +
        `turns=${result.turns} tools=${result.toolCalls.length} ` +
        `tokens_in=${result.tokensIn} tokens_out=${result.tokensOut} ` +
        `tokens_cache_read=${result.tokensCacheRead} tokens_cache_write=${result.tokensCacheWrite} ` +
        `tokens_total=${result.tokensTotal} ` +
        `api_errors=${result.apiErrors} retries=${result.retries} ` +
        `final_stop=${result.finalStopReason}`,
    );
    if (result.apiErrors > 0 && result.lastError) {
      this.writeLog(`Last error: ${result.lastError}`);
    }
    if (result.sessionFile) {
      this.writeLog(`Session: ${result.sessionFile}`);
    }
  }

  private writeLog(msg: string): void {
    const buf = Buffer.from(msg + "\n", "utf-8");
    writeSync(this.logFd, buf);
  }

  close(): void {
    try { closeSync(this.logFd); } catch { /* ignore */ }
    if (this.eventsFd != null) {
      try { closeSync(this.eventsFd); } catch { /* ignore */ }
    }
  }
}

function compactEventLine(line: string): string {
  const byteLen = Buffer.byteLength(line, "utf-8");
  if (byteLen <= RAW_EVENT_MAX_BYTES && !isUpdateEventLine(line)) return line;

  try {
    const event = JSON.parse(line) as Record<string, any>;
    const eventType = String(event.type ?? "");
    const maxBytes = eventType.endsWith("_update")
      ? UPDATE_EVENT_MAX_BYTES
      : RAW_EVENT_MAX_BYTES;

    let compacted = compactValue(event, eventType.endsWith("_update"));
    let out = JSON.stringify(compacted);
    if (Buffer.byteLength(out, "utf-8") <= maxBytes) return out;

    compacted = {
      type: event.type,
      compacted: true,
      originalBytes: byteLen,
      keys: Object.keys(event),
    };
    out = JSON.stringify(compacted);
    return Buffer.byteLength(out, "utf-8") <= maxBytes
      ? out
      : JSON.stringify({ type: event.type, compacted: true, originalBytes: byteLen });
  } catch {
    return JSON.stringify({
      type: "raw_event",
      compacted: true,
      originalBytes: byteLen,
      preview: truncateString(line, MAX_STRING_CHARS),
    });
  }
}

function isUpdateEventLine(line: string): boolean {
  return /"type"\s*:\s*"(?:message_update|tool_execution_update|queue_update)"/.test(line);
}

function compactValue(value: any, aggressive: boolean, depth = 0): any {
  if (value == null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return truncateString(value, aggressive ? 512 : MAX_STRING_CHARS);
  if (Array.isArray(value)) {
    const limit = aggressive ? 3 : MAX_ARRAY_ITEMS;
    const items = value.slice(0, limit).map((v) => compactValue(v, aggressive, depth + 1));
    if (value.length > limit) {
      items.push({ compacted: true, omittedItems: value.length - limit });
    }
    return items;
  }
  if (typeof value === "object") {
    if (depth > (aggressive ? 3 : 6)) {
      return { compacted: true, keys: Object.keys(value) };
    }

    const out: Record<string, any> = {};
    const entries = Object.entries(value).slice(0, MAX_OBJECT_KEYS);
    for (const [k, v] of entries) {
      if (aggressive && isBulkySnapshotField(k)) {
        out[k] = summarizeBulkyField(v);
      } else {
        out[k] = compactValue(v, aggressive, depth + 1);
      }
    }
    const omittedKeys = Object.keys(value).length - entries.length;
    if (omittedKeys > 0) out.__omittedKeys = omittedKeys;
    return out;
  }
  return String(value);
}

function isBulkySnapshotField(key: string): boolean {
  return key === "messages" ||
    key === "message" ||
    key === "partialResult" ||
    key === "result" ||
    key === "content" ||
    key === "details" ||
    key === "progress";
}

function summarizeBulkyField(value: any): Record<string, any> {
  const summary: Record<string, any> = {
    compacted: true,
    originalBytes: Buffer.byteLength(JSON.stringify(value), "utf-8"),
  };
  if (Array.isArray(value)) summary.items = value.length;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    summary.keys = Object.keys(value);
  }
  return summary;
}

function truncateString(s: string, maxChars: number): string {
  return s.length <= maxChars
    ? s
    : `${s.slice(0, maxChars)}… [truncated ${s.length - maxChars} chars]`;
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class Executor {
  constructor(
    private runner: Runner,
    private spec: FlowSpec,
    private workspace: Workspace,
    private workDir: string,
    private flowInputs: Record<string, any>,
    private traceEvents = false,
    private abortSignal?: AbortSignal,
  ) {}

  async execute(
    stage: StageSpec | TaskSpec,
    opts: {
      outputDir?: string;
      iterateFile?: string;
      parentExtensions?: readonly string[];
      parentTools?: readonly string[];
      parentExcludeTools?: readonly string[];
      parentCompactAt?: number;
      reuseSession?: boolean;
    } = {},
  ): Promise<StageResult> {
    let stageId = stage.id;

    // Map sub-tasks: qualify stage_id with item_key
    const itemKey = opts.iterateFile
      ? path.basename(opts.iterateFile, path.extname(opts.iterateFile))
      : undefined;
    if (itemKey) stageId = `${stage.id}/${itemKey}`;

    // Resolve output dir without creating per-stage directories eagerly.
    const outputDir =
      opts.outputDir ?? path.join(this.workspace.root, stageId);

    // Resolve skills
    const skillDirs = [...stage.skills].map((s) =>
      path.join(this.spec.skillsDir, s),
    );

    // Render prompt
    const context: PromptContext = {
      workDir: this.workDir,
      outputDir: this.workspace.root,
      flowInputs: this.flowInputs,
      iterateFile: opts.iterateFile,
      artifacts: this.buildArtifactVars(),
    };

    // Session file
    const stableSession = opts.reuseSession === true;
    const sessionFile = this.workspace.sessionPath(stage.id, itemKey, { stable: stableSession });
    const isReuseTurn = stableSession && existsSync(sessionFile);
    mkdirSync(path.dirname(sessionFile), { recursive: true });
    const taskMessage = isReuseTurn && stage.session.prompt
      ? substituteVars(stage.session.prompt.trim(), context)
      : render(stage, context, this.spec.tasksDir);

    const effectiveTools = stage.tools
      ? [...stage.tools]
      : opts.parentTools
        ? [...opts.parentTools]
        : this.spec.defaultTools
          ? [...this.spec.defaultTools]
          : undefined;
    const effectiveExcludeTools = stage.excludeTools
      ? [...stage.excludeTools]
      : opts.parentExcludeTools
        ? [...opts.parentExcludeTools]
        : this.spec.defaultExcludeTools
          ? [...this.spec.defaultExcludeTools]
          : undefined;

    // Resolve extensions
    let extNames: readonly string[];
    if (isStageSpec(stage) && stage.extensions.length > 0) {
      extNames = stage.extensions;
    } else if (opts.parentExtensions?.length) {
      extNames = opts.parentExtensions;
    } else {
      extNames = this.spec.defaultExtensions;
    }
    const extPaths = this.resolveExtensions(extNames);
    const effectiveCompactAt = stage.session.compactAt ?? opts.parentCompactAt;
    if (effectiveCompactAt != null) {
      const compactionExt = this.runner.modelConfig.compactionExtensionPath;
      if (!compactionExt) {
        throw new Error("Compaction extension path is unavailable");
      }
      extPaths.push(compactionExt);
    }

    // Stage env vars
    const envExtra: Record<string, string> = {
      YOUNGFLOW_STAGE_ID: stageId,
      YOUNGFLOW_OUTPUT_DIR: this.workspace.root,
      YOUNGFLOW_FLOW_DIR: this.spec.flowDir,
      YOUNGFLOW_WORK_DIR: this.workDir,
      PI_SUBAGENT_SOURCES: "builtin",
      ...this.spec.defaultEnv,
    };
    const stageEnv = isStageSpec(stage) ? stage.env : undefined;
    if (stageEnv) Object.assign(envExtra, stageEnv);
    if (effectiveCompactAt != null) {
      envExtra.YOUNGFLOW_COMPACT_AT = String(effectiveCompactAt);
    }
    if (opts.iterateFile) {
      envExtra.YOUNGFLOW_ITERATE_FILE = opts.iterateFile;
    }

    // Event handler
    const handler = new StageEventLogger(this.workspace.logsDir, stageId, {
      traceEvents: this.traceEvents,
    });

    let result;
    try {
      result = await this.runner.run(
        {
          skillDirs,
          task: taskMessage,
          inputFiles: [],
          timeout: stage.timeout,
          model: isStageSpec(stage) ? stage.model : undefined,
          systemPrompt: this.resolveAgentForStage(stage),
          tools: effectiveTools,
          excludeTools: effectiveExcludeTools,
          extensions: extPaths,
          envExtra,
          stageId,
          sessionFile,
          workDir: this.workDir,
          abortSignal: this.abortSignal,
        },
        handler,
      );
    } finally {
      handler.close();
    }

    return {
      stageId,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      outputDir,
      sessionFile: result.sessionFile,
    };
  }

  private buildArtifactVars(): Record<string, string> {
    const s = this.spec;
    const artifacts: Record<string, string> = {
      agents: s.agentsDir,
      skills: s.skillsDir,
      tasks: s.tasksDir,
    };
    if (s.extensionsDir) artifacts.extensions = s.extensionsDir;
    if (s.schemasDir) artifacts.schemas = s.schemasDir;
    if (s.templatesDir) artifacts.templates = s.templatesDir;
    return artifacts;
  }

  private resolveAgentForStage(stage: StageSpec | TaskSpec): string | undefined {
    const agentName = isStageSpec(stage) ? stage.agent : undefined;
    if (agentName) return resolveAgent(this.spec, agentName);
    return undefined;
  }

  private resolveExtensions(extNames: readonly string[]): string[] {
    if (!extNames.length || !this.spec.extensionsDir) return [];
    const resolved: string[] = [];
    for (const name of extNames) {
      const extDir = path.join(this.spec.extensionsDir, name);
      const extFile = path.join(this.spec.extensionsDir, `${name}.ts`);
      if (existsSync(extDir) && statSync(extDir).isDirectory()) {
        resolved.push(extDir);
      } else if (existsSync(extFile)) {
        resolved.push(extFile);
      } else {
        throw new Error(
          `Extension '${name}' not found in ${this.spec.extensionsDir}`,
        );
      }
    }
    return resolved;
  }
}

function isStageSpec(stage: StageSpec | TaskSpec): stage is StageSpec {
  return "routes" in stage;
}
