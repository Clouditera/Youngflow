/**
 * Pi CLI runner: spawn, NDJSON event streaming, retry, timeout.
 *
 * Single responsibility: manage one pi CLI process and parse its output.
 * Event handling is delegated to an EventHandler interface.
 */

import { setMaxListeners } from "node:events";
setMaxListeners(0);
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
const { globSync } = fg;
import type { EngineConfig } from "./engine-config.js";
import type { ModelConfig } from "./model-config.js";
import { logEvent, debug } from "./logger.js";
import {
  formatToolArgsSummary,
  formatToolCallDisplay,
  stringifyLogValue,
  truncateLogText,
} from "./log-format.js";
import { exportSessionMarkdown } from "./session-markdown.js";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface RunResult {
  exitCode: number;
  durationMs: number;
  sessionFile?: string;
  toolCalls: string[];
  turns: number;
  tokensIn: number;
  tokensOut: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  tokensTotal: number;
  apiErrors: number;
  retries: number;
  lastError?: string;
  finalStopReason?: string;
  finalHasContent: boolean;
}

export interface RunConfig {
  skillDirs: string[];
  task: string;
  inputFiles: string[];
  timeout: number;
  model?: string;
  thinkingLevel?: string;
  systemPrompt?: string;
  tools?: string[];
  excludeTools?: string[];
  extensions: string[];
  envExtra: Record<string, string>;
  stageId: string;
  sessionFile?: string;
  workDir?: string;  // pi process cwd (target project path)
  abortSignal?: AbortSignal;
}

export function defaultRunConfig(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    skillDirs: [],
    task: "",
    inputFiles: [],
    timeout: 1800,
    extensions: [],
    envExtra: {},
    stageId: "",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export enum ErrorKind {
  SUCCESS = "success",
  RETRYABLE = "retryable",
  NON_RETRYABLE = "non_retryable",
  TIMEOUT = "timeout",
}

const NON_RETRYABLE_RE =
  /context.?(?:length|window|overflow|too.?long)|max.?(?:context|tokens).?exceeded|auth|invalid.?(?:api.?key|token)|permission.?denied|forbidden|401|403|reasoning_content.*thinking mode.*passed back/i;

const RETRYABLE_RE =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|529|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|timed? out|timeout|terminated|abort|retry delay|provider.?returned.?error|负载较高|稍后重试/i;

export function classifyError(result: RunResult): ErrorKind {
  if (result.exitCode === -1) return ErrorKind.TIMEOUT;

  if (
    result.exitCode === 0 &&
    result.finalStopReason !== "error" &&
    result.finalStopReason != null &&
    result.finalHasContent
  ) {
    return ErrorKind.SUCCESS;
  }

  const err = result.lastError ?? "";
  if (err && NON_RETRYABLE_RE.test(err)) return ErrorKind.NON_RETRYABLE;
  if (err && RETRYABLE_RE.test(err)) return ErrorKind.RETRYABLE;
  if (!result.finalHasContent) return ErrorKind.RETRYABLE;
  return ErrorKind.RETRYABLE;
}

// ---------------------------------------------------------------------------
// Event handler interface
// ---------------------------------------------------------------------------

export interface EventHandler {
  onTurnStart(turn: number, elapsedS: number): void;
  onToolStart(toolName: string, args: Record<string, any>, elapsedS: number): void;
  onToolEnd(toolName: string, isError: boolean, result: string, elapsedS: number): void;
  onMessageEnd(content: any[], usage: Record<string, number>, elapsedS: number): void;
  onRawEvent?(line: string): void;
  onDone(result: RunResult): void;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const RECOVERY_PROMPT =
  "Your previous response was empty or failed (likely an API error). " +
  "The full conversation history has been preserved. " +
  "Please review the context above and continue executing the task.";

export class Runner {
  readonly modelConfig: ModelConfig;
  readonly engineConfig: EngineConfig;
  readonly systemPromptPath: string;
  readonly sessionDir?: string;

  constructor(opts: {
    modelConfig: ModelConfig;
    engineConfig: EngineConfig;
    systemPromptPath: string;
    sessionDir?: string;
  }) {
    this.modelConfig = opts.modelConfig;
    this.engineConfig = opts.engineConfig;
    this.systemPromptPath = opts.systemPromptPath;
    this.sessionDir = opts.sessionDir;
  }

  async run(config: RunConfig, handler?: EventHandler): Promise<RunResult> {
    const ec = this.engineConfig;
    let retryCount = 0;
    let lastResult: RunResult | undefined;

    while (true) {
      let result: RunResult;

      if (retryCount === 0) {
        result = await this.runOnce(config, handler);
      } else {
        const backoff = ec.errorRetryBackoff * 2 ** (retryCount - 1);
        debug("runner", "info", "[%s] Retry %s/%s — waiting %ss...",
          config.stageId, retryCount, ec.errorRetries, backoff.toFixed(0));
        await sleep(backoff * 1000);

        const session = lastResult?.sessionFile;
        if (session) {
          debug("runner", "info", "[%s] Resuming session: %s", config.stageId, session);
          result = await this.runOnce(
            {
              ...config,
              task: RECOVERY_PROMPT,
              sessionFile: session,
              inputFiles: [],
            },
            handler,
          );
        } else {
          result = await this.runOnce(config, handler);
        }
      }

      lastResult = result;
      const kind = classifyError(result);

      if (kind === ErrorKind.SUCCESS) {
        if (retryCount > 0) {
          debug("runner", "info", "[%s] Recovered after %s retry(s)", config.stageId, retryCount);
        }
        return result;
      }
      if (kind === ErrorKind.NON_RETRYABLE) {
        debug("runner", "error", "[%s] Non-retryable error: %s", config.stageId, result.lastError);
        return result;
      }
      if (kind === ErrorKind.TIMEOUT) {
        debug("runner", "error", "[%s] Timeout — not retrying", config.stageId);
        return result;
      }

      retryCount++;
      if (retryCount > ec.errorRetries) {
        debug("runner", "error", "[%s] Retryable error after %s attempt(s): %s",
          config.stageId, retryCount, result.lastError);
        if (result.exitCode === 0) result.exitCode = 3;
        return result;
      }

      logEvent({
        category: "agent",
        event: "retry",
        stage: config.stageId,
        attempt: retryCount,
        max_attempts: ec.errorRetries + 1,
        reason: result.lastError || "empty response",
      });
    }
  }

  private async runOnce(
    config: RunConfig,
    handler?: EventHandler,
  ): Promise<RunResult> {
    const cmd = this.buildCommand(config);
    const stageId = config.stageId || "unknown";
    const startMs = Date.now();

    const cwd = config.workDir ?? process.cwd();
    debug("runner", "info", "[%s] starting pi agent, cwd: %s, cmd:\n%s",
      stageId, cwd, fmtCmd(cmd));
    if (Object.keys(config.envExtra).length > 0) {
      const envSummary = Object.entries(config.envExtra)
        .map(([k, v]) => `${k}=${v}`).join(", ");
      debug("runner", "info", "[%s] env: %s", stageId, envSummary);
    }

    const env = {
      ...process.env,
      ...this.modelConfig.envVars,
      ...config.envExtra,
    };

    return new Promise<RunResult>((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        env,
        cwd: config.workDir ?? undefined,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const toolCalls: string[] = [];
      let turnCount = 0;
      let totalIn = 0;
      let totalOut = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalTokens = 0;
      let apiErrors = 0;
      let retries = 0;
      let lastError: string | undefined;
      let finalStopReason: string | undefined;
      let finalHasContent = false;

      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logEvent({ category: "agent", event: "idle_timeout", stage: stageId, timeout_s: idleTimeoutSec });
          proc.kill();
        }, idleTimeoutSec * 1000);
      };

      const abortProcess = () => {
        proc.kill();
      };

      const idleTimeoutSec = this.engineConfig.idleTimeout;
      timeoutTimer = setTimeout(() => {
        logEvent({ category: "agent", event: "timeout", stage: stageId, timeout_s: config.timeout });
        proc.kill();
      }, config.timeout * 1000);

      if (config.abortSignal) setMaxListeners(0, config.abortSignal);
      config.abortSignal?.addEventListener("abort", abortProcess, { once: true });

      resetIdle();

      let buffer = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        resetIdle();
        buffer += chunk.toString("utf-8");

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const lineStr = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!lineStr) continue;

          handler?.onRawEvent?.(lineStr);

          let event: Record<string, any>;
          try {
            event = JSON.parse(lineStr);
          } catch {
            continue;
          }

          const elapsedS = (Date.now() - startMs) / 1000;
          const eventType = event.type ?? "";

          if (eventType === "turn_start") {
            turnCount++;
            handler?.onTurnStart(turnCount, elapsedS);
          } else if (eventType === "tool_execution_start") {
            const toolName = event.toolName ?? "unknown";
            const args = event.args ?? {};
            toolCalls.push(toolName);
            const summary = formatToolArgsSummary(toolName, args);
            logEvent({
              category: "agent",
              event: "tool_call",
              stage: stageId,
              tool: toolName,
              args_summary: truncateLogText(summary),
              elapsed_s: Math.round(elapsedS),
              status: "ok",
            });
            handler?.onToolStart(toolName, args, elapsedS);
          } else if (eventType === "tool_execution_end") {
            const isErr = event.isError ?? false;
            const toolName = event.toolName ?? "";
            if (isErr) {
              const errResult = truncateLogText(stringifyLogValue(event.result));
              logEvent({
                category: "agent",
                event: "tool_call",
                stage: stageId,
                tool: toolName,
                args_summary: "",
                elapsed_s: Math.round(elapsedS),
                status: "error",
                error_summary: errResult,
              });
              handler?.onToolEnd(toolName, true, errResult, elapsedS);
            }
            if (toolName === "subagent") {
              const [subIn, subOut, subCacheRead, subCacheWrite, subTotal] = extractSubagentUsage(event);
              totalIn += subIn;
              totalOut += subOut;
              totalCacheRead += subCacheRead;
              totalCacheWrite += subCacheWrite;
              totalTokens += subTotal;
            }
          } else if (eventType === "message_end") {
            const msg = event.message ?? {};
            const content = msg.content ?? [];
            const usage = msg.usage ?? {};
            const inTok = Math.max(usage.input ?? 0, 0);
            const outTok = Math.max(usage.output ?? 0, 0);
            const cacheReadTok = Math.max(usage.cacheRead ?? 0, 0);
            const cacheWriteTok = Math.max(usage.cacheWrite ?? 0, 0);
            const computedMessageTotal = inTok + outTok + cacheReadTok + cacheWriteTok;
            const messageTotal = Math.max(usage.totalTokens ?? 0, computedMessageTotal);
            totalIn += inTok;
            totalOut += outTok;
            totalCacheRead += cacheReadTok;
            totalCacheWrite += cacheWriteTok;
            totalTokens += messageTotal;

            const stopReason = msg.stopReason ?? "";
            const errMsgField = msg.errorMessage ?? "";

            finalStopReason = stopReason || undefined;
            finalHasContent = content.length > 0 || outTok > 0;

            if (stopReason === "error" || errMsgField) {
              apiErrors++;
              lastError = errMsgField || stopReason;
              logEvent({
                category: "agent",
                event: "api_error",
                stage: stageId,
                error: lastError ?? "unknown",
                api_errors_total: apiErrors,
              });
            }

            handler?.onMessageEnd(content, usage, elapsedS);
          } else if (eventType === "auto_retry_start") {
            retries++;
            const attempt = event.attempt ?? retries;
            const maxAttempts = event.maxAttempts ?? "?";
            const delay = event.delayMs ?? 0;
            const err = event.errorMessage ?? "";
            logEvent({
              category: "agent",
              event: "auto_retry",
              stage: stageId,
              attempt: Number(attempt),
              max_attempts: Number(maxAttempts),
              delay_ms: Number(delay),
              reason: err,
            });
          } else if (eventType === "auto_retry_end") {
            const success = event.success ?? false;
            const attempt = event.attempt ?? "?";
            if (success) {
              debug("runner", "info", "[%s] [%ss] ✓ retry %s succeeded", stageId, elapsedS.toFixed(0), attempt);
            } else {
              const finalErr = event.finalError ?? "";
              debug("runner", "error", "[%s] [%ss] ❌ retries exhausted: %s", stageId, elapsedS.toFixed(0), finalErr);
            }
          } else if (eventType === "extension_error") {
            const errMsg = event.message ?? "";
            logEvent({ category: "agent", event: "extension_error", stage: stageId, message: errMsg });
          }
        }
      });

      let stderrData = "";
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString("utf-8");
      });

      proc.on("close", (code) => {
        if (idleTimer) clearTimeout(idleTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        config.abortSignal?.removeEventListener("abort", abortProcess);

        const durationMs = Date.now() - startMs;

        // Capture stderr (extension logs, warnings)
        if (stderrData.trim()) {
          for (const line of stderrData.trim().split("\n")) {
            if (line.trim()) {
              debug("runner", "info", "[%s] [stderr] %s", stageId, line.trim());
            }
          }
        }

        const sessionFile =
          config.sessionFile || findLatestSession(this.sessionDir, startMs);

        if (sessionFile && this.engineConfig.exportSessions) {
          exportSessionHtml(sessionFile);
          exportSessionMarkdown(sessionFile, { stageId });
        }

        const result: RunResult = {
          exitCode: code ?? 0,
          durationMs,
          sessionFile: sessionFile ?? undefined,
          toolCalls,
          turns: turnCount,
          tokensIn: totalIn,
          tokensOut: totalOut,
          tokensCacheRead: totalCacheRead,
          tokensCacheWrite: totalCacheWrite,
          tokensTotal: Math.max(totalTokens, totalIn + totalOut + totalCacheRead + totalCacheWrite),
          apiErrors,
          retries,
          lastError,
          finalStopReason,
          finalHasContent,
        };

        logEvent({
          category: "stage",
          event: "stage_done",
          stage: stageId,
          exit_code: result.exitCode,
          duration_ms: durationMs,
          turns: turnCount,
          tools: toolCalls.length,
          tokens_in: totalIn,
          tokens_out: totalOut,
          tokens_cache_read: totalCacheRead,
          tokens_cache_write: totalCacheWrite,
          tokens_total: Math.max(totalTokens, totalIn + totalOut + totalCacheRead + totalCacheWrite),
          api_errors: apiErrors,
          retries,
          final_stop: finalStopReason,
          session_file: result.sessionFile,
        });

        handler?.onDone(result);
        resolve(result);
      });

      proc.on("error", (err) => {
        logEvent({ category: "stage", event: "process_error", stage: stageId, error: String(err) });
        if (idleTimer) clearTimeout(idleTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        config.abortSignal?.removeEventListener("abort", abortProcess);
        if (proc.exitCode === null) proc.kill();
        resolve({
          exitCode: -1,
          durationMs: Date.now() - startMs,
          toolCalls: [],
          turns: 0,
          tokensIn: 0,
          tokensOut: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          tokensTotal: 0,
          apiErrors: 0,
          retries: 0,
          finalHasContent: false,
        });
      });
    });
  }

  private buildCommand(config: RunConfig): string[] {
    const modelStr = config.model ?? this.modelConfig.modelString;
    const thinking = config.thinkingLevel ?? this.modelConfig.thinkingLevel;
    const promptPath = config.systemPrompt ?? this.systemPromptPath;
    const cmd = [
      "pi",
      "-p",
      "--mode",
      "json",
      "--system-prompt",
      promptPath,
      "--no-skills",
    ];
    for (const skillDir of config.skillDirs) {
      cmd.push("--skill", skillDir);
    }
    cmd.push("--no-extensions");
    for (const extPath of config.extensions) {
      cmd.push("-e", extPath);
    }
    cmd.push(
      "--no-prompt-templates",
      "--no-themes",
      "--model",
      modelStr,
    );
    if (thinking) {
      cmd.push("--thinking", thinking);
    }
    cmd.push(
      "--tools",
      config.tools && config.tools.length > 0 ? config.tools.join(",") : "read,bash,edit,write",
    );
    if (config.excludeTools && config.excludeTools.length > 0) {
      cmd.push("--exclude-tools", config.excludeTools.join(","));
    }
    if (config.sessionFile) {
      cmd.push("--session", config.sessionFile);
    } else if (this.sessionDir) {
      cmd.push("--session-dir", this.sessionDir);
    }
    for (const f of config.inputFiles) {
      cmd.push(`@${f}`);
    }
    cmd.push(config.task);
    return cmd;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractSubagentUsage(event: Record<string, any>): [number, number, number, number, number] {
  const result = event.result;
  if (typeof result !== "object" || result === null) return [0, 0, 0, 0, 0];
  const details = result.details;
  if (typeof details !== "object" || details === null) return [0, 0, 0, 0, 0];
  let subIn = 0;
  let subOut = 0;
  let subCacheRead = 0;
  let subCacheWrite = 0;
  let subTotal = 0;
  for (const r of details.results ?? []) {
    const usage = r.usage ?? {};
    const inTok = Math.max(usage.input ?? 0, 0);
    const outTok = Math.max(usage.output ?? 0, 0);
    const cacheReadTok = Math.max(usage.cacheRead ?? 0, 0);
    const cacheWriteTok = Math.max(usage.cacheWrite ?? 0, 0);
    const computed = inTok + outTok + cacheReadTok + cacheWriteTok;
    subIn += inTok;
    subOut += outTok;
    subCacheRead += cacheReadTok;
    subCacheWrite += cacheWriteTok;
    subTotal += Math.max(usage.totalTokens ?? 0, computed);
  }
  return [subIn, subOut, subCacheRead, subCacheWrite, Math.max(subTotal, subIn + subOut + subCacheRead + subCacheWrite)];
}

export { stringifyLogValue as stringifyToolResult } from "./log-format.js";
export { formatToolArgsSummary, formatToolArgsSummary as formatToolArgs } from "./log-format.js";
export { formatToolCallDisplay, formatToolCallDisplay as formatTool } from "./log-format.js";

function findLatestSession(
  sessionDir: string | undefined,
  startMs: number,
): string | undefined {
  if (!sessionDir || !existsSync(sessionDir)) return undefined;
  const startTime = startMs / 1000;
  const files = globSync("**/*.jsonl", { cwd: sessionDir, absolute: true });
  const candidates = files.filter((f) => {
    try {
      return statSync(f).mtimeMs / 1000 >= startTime;
    } catch {
      return false;
    }
  });
  if (candidates.length === 0) return undefined;
  return candidates.sort((a, b) => {
    return statSync(b).mtimeMs - statSync(a).mtimeMs;
  })[0];
}

function exportSessionHtml(sessionFile: string): void {
  const htmlPath = sessionFile.replace(".jsonl", ".html");
  try {
    execSync(`pi --export ${sessionFile} ${htmlPath}`, {
      timeout: 30000,
      stdio: "ignore",
    });
    debug("runner", "info", "[runner] Session exported: %s", htmlPath);
  } catch {
    debug("runner", "warning", "[runner] Failed to export session: %s", sessionFile);
  }
}

export function loadEnvFile(envPath?: string): Record<string, string> {
  if (!envPath || !existsSync(envPath)) return {};
  const env: Record<string, string> = {};
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eqIdx = trimmed.indexOf("=");
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && value) env[key] = value;
  }
  if (Object.keys(env).length > 0) {
    debug("runner", "info", "Loaded %s env vars from %s", Object.keys(env).length, path.basename(envPath));
  }
  return env;
}

// ---------------------------------------------------------------------------
// Command formatting (readable multi-line layout for logging)
// ---------------------------------------------------------------------------

function fmtCmd(cmd: string[], maxArgLen = 160, maxTaskLines = 8): string {
  if (cmd.length === 0) return "  <empty command>";

  const lines: string[] = [`  ${shellQuote(cmd[0])}`];
  let i = 1;

  while (i < cmd.length) {
    const arg = cmd[i];

    // Final positional arg is always the task/prompt
    if (i === cmd.length - 1) {
      lines.push("  <task> |");
      lines.push(...fmtTaskBlock(arg, maxArgLen, maxTaskLines));
      break;
    }

    // Flag + value pair
    if (arg.startsWith("-") && i + 1 < cmd.length && !cmd[i + 1].startsWith("-")) {
      const value = truncateArg(cmd[i + 1], maxArgLen);
      lines.push(`  ${arg} ${shellQuote(value)}`);
      i += 2;
      continue;
    }

    // Standalone flag or positional input file (@file)
    lines.push(`  ${shellQuote(truncateArg(arg, maxArgLen))}`);
    i += 1;
  }

  return lines.join("\n");
}

function truncateArg(arg: string, maxLen: number): string {
  if (arg.length <= maxLen) return arg;
  return arg.slice(0, maxLen) + `...(${arg.length}ch)`;
}

function fmtTaskBlock(task: string, maxArgLen: number, maxLines: number): string[] {
  const preview = truncateArg(task, maxArgLen * maxLines);
  const rawLines = preview.split("\n");
  const shown = rawLines.slice(0, maxLines);
  const lines = shown.map((line) => `    ${line}`);
  if (rawLines.length > maxLines) {
    lines.push(`    ...(truncated, ${task.length}ch total)`);
  } else if (task.length > preview.length) {
    lines.push(`    ...(truncated, ${task.length}ch total)`);
  }
  return lines;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9._\-/:@=,]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}
