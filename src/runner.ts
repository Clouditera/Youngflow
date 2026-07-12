/**
 * Pi CLI runner: spawn, NDJSON event streaming, retry, timeout.
 *
 * Single responsibility: manage one pi CLI process and parse its output.
 * Event handling is delegated to an EventHandler interface.
 */

import { createHash } from "node:crypto";
import { setMaxListeners } from "node:events";
setMaxListeners(0);
import { spawn, spawnSync, execSync } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
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
  executionPolicy?: "prepare-restricted";
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
      // Restricted Prepare outer retry is always zero: a retry must start from
      // a fresh private control directory/session/counter set in the caller.
      if (config.executionPolicy === "prepare-restricted") return result;
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
    if (config.executionPolicy === "prepare-restricted") assertRestrictedPrepareCommand(cmd);
    const stageId = config.stageId || "unknown";
    const startMs = Date.now();

    const cwd = config.workDir ?? process.cwd();
    if (config.executionPolicy === "prepare-restricted") {
      debug("runner", "info", "[%s] starting restricted pi agent (argv preflight passed)", stageId);
    } else {
      debug("runner", "info", "[%s] starting pi agent, cwd: %s, cmd:\n%s", stageId, cwd, fmtCmd(cmd));
    }
    const env: NodeJS.ProcessEnv = config.executionPolicy === "prepare-restricted"
      ? buildRestrictedPrepareEnv(process.env, this.modelConfig.envVars, config.envExtra, config.model ?? this.modelConfig.modelString)
      : { ...process.env, ...this.modelConfig.envVars, ...config.envExtra };
    if (Object.keys(config.envExtra).length > 0) {
      const envSummary = config.executionPolicy === "prepare-restricted"
        ? Object.keys(env).sort().join(",")
        : Object.entries(config.envExtra).map(([k, v]) => `${k}=${v}`).join(", ");
      debug("runner", "info", "[%s] env%s: %s", stageId, config.executionPolicy ? " keys" : "", envSummary);
    }

    return new Promise<RunResult>((resolve) => {
      const proc = spawn(cmd[0], cmd.slice(1), {
        env,
        cwd: config.workDir ?? undefined,
        stdio: ["ignore", "pipe", "pipe"],
        detached: config.executionPolicy === "prepare-restricted",
      });
      const killProcess = () => {
        if (config.executionPolicy === "prepare-restricted" && proc.pid) {
          try { process.kill(-proc.pid, "SIGKILL"); return; } catch { /* process already gone */ }
          try { proc.kill("SIGKILL"); } catch { /* process already gone */ }
          return;
        }
        try { proc.kill(); } catch { /* process already gone */ }
      };

      const toolCalls: string[] = [];
      const restrictedToolStarts = { total: 0, manifest: 0, file: 0, submit: 0 };
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
      let aborted = false;
      let timedOut = false;
      let idleTimedOut = false;
      let policyKilled = false;
      let processErrored = false;

      const resetIdle = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logEvent({ category: "agent", event: "idle_timeout", stage: stageId, timeout_s: idleTimeoutSec });
          if (config.executionPolicy === "prepare-restricted") {
            idleTimedOut = true;
            cleanupRestrictedPrepareOutput(env);
          }
          killProcess();
        }, idleTimeoutSec * 1000);
      };

      const abortProcess = () => {
        aborted = true;
        if (config.executionPolicy === "prepare-restricted") cleanupRestrictedPrepareOutput(env);
        killProcess();
      };

      const idleTimeoutSec = config.executionPolicy === "prepare-restricted" ? 90 : this.engineConfig.idleTimeout;
      timeoutTimer = setTimeout(() => {
        logEvent({ category: "agent", event: "timeout", stage: stageId, timeout_s: config.timeout });
        if (config.executionPolicy === "prepare-restricted") {
          timedOut = true;
          cleanupRestrictedPrepareOutput(env);
        }
        killProcess();
      }, config.timeout * 1000);

      if (config.abortSignal) setMaxListeners(0, config.abortSignal);
      config.abortSignal?.addEventListener("abort", abortProcess, { once: true });

      resetIdle();

      let buffer = "";
      proc.stdout!.on("data", (chunk: Buffer) => {
        if (policyKilled) return;
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
            if (config.executionPolicy === "prepare-restricted" && turnCount > 24) {
              lastError = "prepare turn budget exceeded";
              policyKilled = true;
              cleanupRestrictedPrepareOutput(env);
              killProcess();
            }
            handler?.onTurnStart(turnCount, elapsedS);
          } else if (eventType === "tool_execution_start") {
            const toolName = event.toolName ?? "unknown";
            const args = event.args ?? {};
            toolCalls.push(toolName);
            if (config.executionPolicy === "prepare-restricted") {
              restrictedToolStarts.total++;
              if (toolName === "read_project_manifest") restrictedToolStarts.manifest++;
              else if (toolName === "read_project_file") restrictedToolStarts.file++;
              else if (toolName === "submit_plan") restrictedToolStarts.submit++;
              const unauthorized = !PREPARE_TOOL_ALLOWLIST.has(toolName);
              const overBudget = exceedsRestrictedPrepareToolBudget(restrictedToolStarts);
              if (unauthorized || overBudget) {
                lastError = unauthorized ? "unauthorized prepare tool" : "prepare tool budget exceeded";
                policyKilled = true;
                cleanupRestrictedPrepareOutput(env);
                buffer = "";
                killProcess();
                return;
              }
            }
            const summary = formatRestrictedToolArgsSummary(toolName, args);
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
              const errResult = config.executionPolicy === "prepare-restricted"
                ? (toolName === "submit_plan" ? "submit_plan validation failed (<redacted>)" : "restricted tool error")
                : truncateLogText(stringifyLogValue(event.result));
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
            if (config.executionPolicy === "prepare-restricted"
              && (Math.max(totalTokens, totalIn + totalOut + totalCacheRead + totalCacheWrite) > 200_000 || totalOut > 24_000)) {
              lastError = "prepare token budget exceeded";
              policyKilled = true;
              cleanupRestrictedPrepareOutput(env);
              killProcess();
            }

            const stopReason = msg.stopReason ?? "";
            const errMsgField = msg.errorMessage ?? "";

            finalStopReason = stopReason || undefined;
            finalHasContent = content.length > 0 || outTok > 0;

            if (stopReason === "error" || errMsgField) {
              apiErrors++;
              lastError = config.executionPolicy === "prepare-restricted" ? "provider error" : (errMsgField || stopReason);
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
            const err = config.executionPolicy === "prepare-restricted" ? "provider retry" : (event.errorMessage ?? "");
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
              const finalErr = config.executionPolicy === "prepare-restricted" ? "provider retries exhausted" : (event.finalError ?? "");
              debug("runner", "error", "[%s] [%ss] ❌ retries exhausted: %s", stageId, elapsedS.toFixed(0), finalErr);
            }
          } else if (eventType === "extension_error") {
            const errMsg = config.executionPolicy === "prepare-restricted" ? "restricted extension error" : (event.message ?? "");
            logEvent({ category: "agent", event: "extension_error", stage: stageId, message: errMsg });
          }
        }
      });

      let stderrData = "";
      proc.stderr!.on("data", (chunk: Buffer) => {
        stderrData += chunk.toString("utf-8");
      });

      proc.on("close", (code, signal) => {
        if (idleTimer) clearTimeout(idleTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        config.abortSignal?.removeEventListener("abort", abortProcess);

        const durationMs = Date.now() - startMs;

        // Restricted stderr may contain provider/extension/source data; only
        // persist safe counters, never raw lines.
        if (stderrData.trim()) {
          if (config.executionPolicy === "prepare-restricted") {
            debug("runner", "info", "[%s] restricted stderr: bytes=%s lines=%s", stageId, Buffer.byteLength(stderrData), stderrData.trim().split("\n").length);
          } else {
            for (const line of stderrData.trim().split("\n")) {
              if (line.trim()) debug("runner", "info", "[%s] [stderr] %s", stageId, line.trim());
            }
          }
        }

        const sessionFile = config.executionPolicy === "prepare-restricted"
          ? undefined
          : config.sessionFile || findLatestSession(this.sessionDir, startMs);

        if (sessionFile && this.engineConfig.exportSessions) {
          exportSessionHtml(sessionFile);
          exportSessionMarkdown(sessionFile, { stageId });
        }

        const submitEvents = toolCalls.filter((tool) => tool === "submit_plan").length;
        const policyFailed = config.executionPolicy === "prepare-restricted"
          && (code !== 0
            || signal != null
            || aborted
            || timedOut
            || idleTimedOut
            || policyKilled
            || processErrored
            || turnCount > 24
            || totalOut > 24_000
            || Math.max(totalTokens, totalIn + totalOut + totalCacheRead + totalCacheWrite) > 200_000
            || toolCalls.some((tool) => !PREPARE_TOOL_ALLOWLIST.has(tool))
            || submitEvents < 1
            || submitEvents > 3
            || !verifyRestrictedPrepareArtifacts(env, config, submitEvents));
        if (config.executionPolicy === "prepare-restricted") {
          if (policyFailed) cleanupRestrictedPrepareOutput(env);
          cleanupRestrictedPrepareControl(env);
        }
        const result: RunResult = {
          exitCode: policyFailed ? 3 : (processErrored ? -1 : (code ?? 3)),
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
        processErrored = true;
        lastError = config.executionPolicy === "prepare-restricted" ? "restricted process error" : String(err);
        logEvent({ category: "stage", event: "process_error", stage: stageId, error: lastError });
        if (idleTimer) clearTimeout(idleTimer);
        if (timeoutTimer) clearTimeout(timeoutTimer);
        config.abortSignal?.removeEventListener("abort", abortProcess);
        if (config.executionPolicy === "prepare-restricted") {
          cleanupRestrictedPrepareOutput(env);
          cleanupRestrictedPrepareControl(env);
          return;
        }
        resolve({
          exitCode: -1, durationMs: Date.now() - startMs, toolCalls: [], turns: 0,
          tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0, tokensTotal: 0,
          apiErrors: 0, retries: 0, lastError, finalHasContent: false,
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
    );
    if (config.executionPolicy === "prepare-restricted") {
      cmd.push("--no-context-files", "--no-approve", "--offline", "--no-session");
    }
    cmd.push("--model", modelStr);
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
    if (config.executionPolicy !== "prepare-restricted") {
      if (config.sessionFile) {
        cmd.push("--session", config.sessionFile);
      } else if (this.sessionDir) {
        cmd.push("--session-dir", this.sessionDir);
      }
    }
    for (const f of config.inputFiles) {
      cmd.push(`@${f}`);
    }
    cmd.push(config.task);
    return cmd;
  }
}

// ---------------------------------------------------------------------------
// Restricted Prepare execution policy + helpers
// ---------------------------------------------------------------------------

const PREPARE_TOOL_ALLOWLIST = new Set(["read_project_manifest", "read_project_file", "submit_plan"]);

export function exceedsRestrictedPrepareToolBudget(counts: Readonly<{ total: number; manifest: number; file: number; submit: number }>): boolean {
  return counts.total > 48 || counts.manifest > 12 || counts.file > 32 || counts.submit > 3;
}

function restrictedToolDisplay(toolName: string, args: Record<string, any>): string | undefined {
  if (toolName === "submit_plan") {
    const bytes = Buffer.byteLength(JSON.stringify(args?.plan ?? null), "utf8");
    return `submit_plan(plan=<redacted>, serialized_bytes=${bytes})`;
  }
  if (toolName === "read_project_file") {
    return `read_project_file(path=${String(args?.path ?? "")}, offset=${Number(args?.offset ?? 1)}, limit=${Number(args?.limit ?? 100)})`;
  }
  if (toolName === "read_project_manifest") {
    return `read_project_manifest(section=${String(args?.section ?? "overview")}, cursor=${Number(args?.cursor ?? 0)}, limit=${Number(args?.limit ?? 100)})`;
  }
  return undefined;
}

export function formatRestrictedToolArgsSummary(toolName: string, args: Record<string, any>): string {
  return restrictedToolDisplay(toolName, args) ?? formatToolArgsSummary(toolName, args);
}

export function formatRestrictedToolCallDisplay(toolName: string, args: Record<string, any>): string {
  return restrictedToolDisplay(toolName, args) ?? formatToolCallDisplay(toolName, args);
}

export function assertRestrictedPrepareCommand(cmd: readonly string[]): void {
  const required = [
    "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
    "--no-context-files", "--no-approve", "--offline", "--no-session",
  ];
  for (const flag of required) if (!cmd.includes(flag)) throw new Error(`prepare command missing ${flag}`);
  if (cmd.includes("--session") || cmd.includes("--session-dir")) throw new Error("prepare command enables session persistence");
  const toolIndex = cmd.indexOf("--tools");
  if (toolIndex < 0 || cmd[toolIndex + 1] !== "read_project_manifest,read_project_file,submit_plan") {
    throw new Error("prepare command tool allowlist mismatch");
  }
  if (cmd.filter((arg) => arg === "-e").length !== 1) throw new Error("prepare command must load exactly one extension");
  if (cmd.filter((arg) => arg === "--skill").length !== 1) throw new Error("prepare command must load exactly one skill");
}

export function buildRestrictedPrepareEnv(
  processEnv: NodeJS.ProcessEnv,
  modelEnv: Record<string, string>,
  envExtra: Record<string, string>,
  modelString: string,
): Record<string, string> {
  const merged: Record<string, string | undefined> = { ...processEnv, ...modelEnv, ...envExtra };
  const env: Record<string, string> = {};
  const copy = (key: string) => { if (merged[key] !== undefined) env[key] = String(merged[key]); };
  for (const key of ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"]) copy(key);
  for (const key of Object.keys(merged)) {
    if (/^PREPARE_(?:SOURCE_ROOT|CONTROL_DIR|OUTPUT_DIR|PLANNER_INPUT|MANIFEST_SCHEMA|PLAN_SCHEMA|PI_HOME)$/.test(key)
      || /^YOUNGFLOW_(?:STAGE_ID|OUTPUT_DIR|FLOW_DIR|WORK_DIR)$/.test(key)) copy(key);
  }
  const provider = modelString.split("/", 1)[0]?.toLowerCase() ?? "";
  const providerKeys: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
    openai: ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    "openai-codex": ["OPENAI_API_KEY", "OPENAI_BASE_URL"],
    google: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"],
    azure: ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"],
    bedrock: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION"],
    zai: ["ZAI_API_KEY", "ZAI_BASE_URL"],
  };
  for (const key of providerKeys[provider] ?? ["V_PREPARE_MODEL_API_KEY", "V_PREPARE_MODEL_BASE_URL"]) copy(key);

  const controlDir = env.PREPARE_CONTROL_DIR;
  const piHome = merged.PI_CODING_AGENT_DIR;
  if (!controlDir || !piHome) throw new Error("prepare-restricted requires private control and pi home");
  const home = path.join(controlDir, "home");
  const tmp = path.join(controlDir, "tmp");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(tmp, { recursive: true, mode: 0o700 });
  mkdirSync(piHome, { recursive: true, mode: 0o700 });
  const stableControl = realpathSync(controlDir);
  const stablePiHome = realpathSync(piHome);
  const relativePiHome = path.relative(stableControl, stablePiHome);
  if (!relativePiHome || relativePiHome.startsWith("..") || path.isAbsolute(relativePiHome)) throw new Error("prepare-restricted pi home must be inside control");
  env.HOME = home;
  env.TMPDIR = tmp;
  env.PREPARE_PI_HOME = piHome;
  env.PI_CODING_AGENT_DIR = piHome;
  env.PI_OFFLINE = "1";
  return env;
}

function readNoFollow(pathname: string, maxBytes: number): { bytes: Buffer; mode: number } | null {
  let fd: number;
  try { fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) return null;
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const count = readSync(fd, bytes, offset, stat.size - offset, offset);
      if (count < 1) return null;
      offset += count;
    }
    return { bytes, mode: stat.mode & 0o777 };
  } finally { closeSync(fd); }
}

export function buildRestrictedPostflightEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const postflight: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH", "LANG", "LC_ALL", "HOME", "TMPDIR",
    "PREPARE_SOURCE_ROOT", "PREPARE_CONTROL_DIR", "PREPARE_OUTPUT_DIR",
    "PREPARE_PLANNER_INPUT", "PREPARE_MANIFEST_SCHEMA", "PREPARE_PLAN_SCHEMA",
  ]) {
    if (env[key] !== undefined) postflight[key] = env[key];
  }
  return postflight;
}

function verifyRestrictedPrepareArtifacts(env: NodeJS.ProcessEnv, config: RunConfig, submitEvents: number): boolean {
  const outputDir = env.PREPARE_OUTPUT_DIR;
  const controlDir = env.PREPARE_CONTROL_DIR;
  const extensionDir = config.extensions[0];
  if (!outputDir || !controlDir || !extensionDir || submitEvents < 1 || submitEvents > 3) return false;
  try {
    if (readdirSync(outputDir).sort().join(",") !== "assessment-plan.json") return false;
    const plan = readNoFollow(path.join(outputDir, "assessment-plan.json"), 128 * 1024);
    if (!plan || plan.mode !== 0o600) return false;
    const postflight = path.join(extensionDir, "postflight.mjs");
    const nodeExecutable = path.basename(process.execPath).startsWith("node")
      ? process.execPath
      : (existsSync("/usr/local/bin/node") ? "/usr/local/bin/node" : "/usr/bin/node");
    const result = spawnSync(nodeExecutable, [postflight], {
      cwd: controlDir,
      env: buildRestrictedPostflightEnv(env),
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    });
    if (result.status !== 0 || result.signal != null || result.error) return false;
    const verified = JSON.parse(result.stdout || "{}");
    const counters = verified.counters;
    return verified.ok === true
      && verified.plan_sha256 === createHash("sha256").update(plan.bytes).digest("hex")
      && Number.isSafeInteger(counters?.submitCalls)
      && counters.submitCalls === submitEvents
      && counters.submitCalls >= 1
      && counters.submitCalls <= 3
      && Number.isSafeInteger(counters?.totalCalls)
      && counters.totalCalls >= counters.submitCalls;
  } catch { return false; }
}

function cleanupRestrictedPrepareOutput(env: NodeJS.ProcessEnv): void {
  const outputDir = env.PREPARE_OUTPUT_DIR;
  if (!outputDir) return;
  try {
    for (const name of readdirSync(outputDir)) rmSync(path.join(outputDir, name), { recursive: true, force: true });
  } catch { /* dedicated output may already be gone */ }
}

function cleanupRestrictedPrepareControl(env: NodeJS.ProcessEnv): void {
  const controlDir = env.PREPARE_CONTROL_DIR;
  if (!controlDir) return;
  for (const target of [env.PREPARE_PI_HOME, env.HOME, env.TMPDIR, path.join(controlDir, "runtime"), path.join(controlDir, "receipt.json")]) {
    if (!target) continue;
    try { rmSync(target, { recursive: true, force: true }); } catch { /* best effort; launcher removes the control root */ }
  }
}

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
