import path from "node:path";
import { format as utilFormat } from "node:util";

export function formatLogTime(date = new Date()): string {
  return date.toISOString().slice(11, 19);
}

export function truncateLogText(text: string, maxChars = 200): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return text.slice(0, maxChars - 3) + "...";
}

export function stringifyLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  if (value instanceof Error) return value.message || value.stack || String(value);
  if (typeof value === "object") {
    const obj = value as Record<string, any>;
    const message = obj.message ?? obj.error ?? obj.stderr ?? obj.stdout ?? obj.text;
    if (typeof message === "string" && message.trim()) return message;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function formatDebugMessage(message: string, args: unknown[]): string {
  return args.length === 0 ? message : utilFormat(message, ...args);
}

export function formatToolArgsSummary(toolName: string, args: Record<string, any>): string {
  if (toolName === "read") {
    const p = args.path ?? "";
    const suffix = formatReadRange(args);
    return p ? `${shortPath(p)}${suffix}` : "";
  }
  if (toolName === "write" || toolName === "edit") {
    const p = args.path ?? "";
    return p ? shortPath(p) : "";
  }
  if (toolName === "bash") {
    const cmd = String(args.command ?? "").replace(/\n/g, " ").trim();
    return truncateLogText(cmd, 100);
  }
  return "";
}

export function formatToolCallDisplay(toolName: string, args: Record<string, any>): string {
  const summary = formatToolArgsSummary(toolName, args);
  return summary ? `${toolName}: ${summary}` : toolName;
}

function formatReadRange(args: Record<string, any>): string {
  const offset = args.offset;
  const limit = args.limit;
  if (offset != null && limit != null) return ` [${offset}:${offset + limit}]`;
  if (offset != null) return ` [${offset}:]`;
  if (limit != null) return ` [:${limit}]`;
  return "";
}

function shortPath(p: string, maxParts = 4): string {
  const normalized = p.split(path.sep).join("/");
  const parts = normalized.split("/");
  return parts.length <= maxParts
    ? p
    : "..." + parts.slice(-maxParts).join("/");
}
