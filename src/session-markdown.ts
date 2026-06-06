import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { debug } from "./logger.js";

const DEFAULT_TOOL_RESULT_MAX_CHARS = 1500;
const DEFAULT_TOOL_RESULT_MAX_LINES = 30;
const SUPPORTED_SESSION_VERSION = 3;

export interface SessionMarkdownOptions {
  readonly stageId?: string;
  readonly toolResultMaxChars?: number;
  readonly toolResultMaxLines?: number;
}

interface SessionMeta {
  id?: string;
  timestamp?: string;
  cwd?: string;
}

interface ModelMeta {
  provider?: string;
  modelId?: string;
}

export function exportSessionMarkdown(sessionFile: string, options: SessionMarkdownOptions = {}): string | undefined {
  const mdPath = sessionFile.replace(/\.jsonl$/i, ".md");
  try {
    const markdown = renderSessionMarkdown(readFileSync(sessionFile, "utf-8"), {
      ...options,
      stageId: options.stageId ?? path.basename(sessionFile, path.extname(sessionFile)),
    });
    writeFileSync(mdPath, markdown);
    debug("runner", "info", "[runner] Session markdown exported: %s", mdPath);
    return mdPath;
  } catch (e) {
    debug("runner", "warning", "[runner] Failed to export session markdown: %s: %s", sessionFile, e);
    return undefined;
  }
}

export function renderSessionMarkdown(jsonl: string, options: SessionMarkdownOptions = {}): string {
  const maxChars = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS;
  const maxLines = options.toolResultMaxLines ?? DEFAULT_TOOL_RESULT_MAX_LINES;
  const lines = jsonl.split(/\r?\n/);
  const out: string[] = [];
  const warnings: string[] = [];
  const session: SessionMeta = {};
  const model: ModelMeta = {};
  let turn = 0;
  let unsupportedVersion = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      warnings.push(`Line ${i + 1}: invalid JSON skipped`);
      debug("runner", "warning", "[runner] session markdown: invalid JSONL line %s skipped", i + 1);
      continue;
    }

    if (unsupportedVersion) continue;

    if (event.type === "session") {
      const version = Number(event.version ?? SUPPORTED_SESSION_VERSION);
      if (Number.isFinite(version) && version !== SUPPORTED_SESSION_VERSION) {
        unsupportedVersion = true;
        warnings.push(`Unsupported session JSONL version ${version}; content skipped`);
        debug("runner", "warning", "[runner] session markdown: unsupported session JSONL version %s", version);
        continue;
      }
      session.id = stringValue(event.id ?? event.sessionId);
      session.timestamp = stringValue(event.timestamp ?? event.createdAt);
      session.cwd = stringValue(event.cwd);
      continue;
    }

    if (event.type === "model_change") {
      model.provider = stringValue(event.provider ?? event.model?.provider);
      model.modelId = stringValue(event.modelId ?? event.model_id ?? event.model?.modelId ?? event.model?.id);
      continue;
    }

    if (event.type === "message") {
      const message = event.message ?? {};
      const role = stringValue(message.role ?? event.role) ?? "unknown";
      const content = Array.isArray(message.content) ? message.content : Array.isArray(event.content) ? event.content : [];
      turn++;
      out.push(`## Turn ${turn} · ${titleRole(role)}`, "");
      renderContentBlocks(out, content, maxChars, maxLines);
      continue;
    }
  }

  return [
    `# Session: ${options.stageId ?? session.id ?? "unknown"}`,
    "",
    `- Stage/Item: ${options.stageId ?? "unknown"}`,
    `- Session ID: ${session.id ?? "unknown"}`,
    `- Model: ${formatModel(model)}`,
    `- Started: ${session.timestamp ?? "unknown"}`,
    session.cwd ? `- CWD: ${session.cwd}` : undefined,
    warnings.length > 0 ? `- Warnings: ${warnings.length}` : undefined,
    "",
    warnings.length > 0 ? ["## Warnings", "", ...warnings.map((w) => `- ${w}`), ""] : undefined,
    out.length > 0 ? out : ["_No supported session messages found._", ""],
  ].flat().filter((v): v is string => v !== undefined).join("\n");
}

function renderContentBlocks(out: string[], blocks: any[], maxChars: number, maxLines: number): void {
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const type = block.type;
    if (type === "text") {
      const text = stringValue(block.text ?? block.content);
      if (text) out.push(text, "");
    } else if (type === "thinking") {
      const thinking = stringValue(block.thinking ?? block.text ?? block.content);
      if (thinking) out.push("### 🤔 Thinking", "", thinking, "");
    } else if (type === "toolCall") {
      const name = stringValue(block.name ?? block.toolName) ?? "unknown";
      const args = block.arguments ?? block.args ?? {};
      out.push(`### 🔧 Tool Call: ${name}`, "", "```json", formatJson(args), "```", "");
    } else if (type === "toolResult") {
      const result = extractToolResultText(block);
      const truncated = truncateText(result, maxChars, maxLines);
      out.push(truncated.truncated ? "### 📎 Tool Result (truncated)" : "### 📎 Tool Result", "", truncated.text);
      if (truncated.truncated) out.push(`... [truncated ${truncated.remainingChars} more chars]`);
      out.push("");
    }
  }
}

function extractToolResultText(block: Record<string, any>): string {
  if (typeof block.text === "string") return block.text;
  if (typeof block.result === "string") return block.result;
  if (Array.isArray(block.content)) {
    return block.content.map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object") return stringValue(item.text ?? item.content) ?? "";
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

function truncateText(text: string, maxChars: number, maxLines: number): { text: string; truncated: boolean; remainingChars: number } {
  const byLine = text.split(/\r?\n/);
  let limit = text.length;
  if (byLine.length > maxLines) {
    limit = Math.min(limit, byLine.slice(0, maxLines).join("\n").length);
  }
  if (text.length > maxChars) limit = Math.min(limit, maxChars);
  if (limit >= text.length) return { text, truncated: false, remainingChars: 0 };
  return { text: text.slice(0, limit), truncated: true, remainingChars: text.length - limit };
}

function formatModel(model: ModelMeta): string {
  if (model.provider && model.modelId) return `${model.provider}/${model.modelId}`;
  return model.modelId ?? model.provider ?? "unknown";
}

function titleRole(role: string): string {
  return role.slice(0, 1).toUpperCase() + role.slice(1);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value ?? {}, null, 2);
}
