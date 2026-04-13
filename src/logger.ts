/**
 * Lightweight logger aligned with Python's logging module.
 *
 * Each module gets a named logger via getLogger("youngflow.xxx").
 * Console output goes to stderr; file output (when attached) captures
 * all module logs at DEBUG level for full diagnostics.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export enum LogLevel {
  DEBUG = 10,
  INFO = 20,
  WARNING = 30,
  ERROR = 40,
}

let globalLevel: LogLevel = LogLevel.INFO;
let logFilePath: string | undefined;
// File handler always logs at DEBUG for full diagnostics
const FILE_LEVEL: LogLevel = LogLevel.DEBUG;

export function setLevel(level: LogLevel): void {
  globalLevel = level;
}

/**
 * Attach a file handler to all loggers.
 * Called after workspace is created so the path exists.
 */
export function attachFileHandler(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  logFilePath = filePath;
}

const LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARNING]: "WARNING",
  [LogLevel.ERROR]: "ERROR",
};

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warning(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

function formatMsg(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;
  // Python-style %s substitution
  let i = 0;
  return msg.replace(/%s/g, () => (i < args.length ? String(args[i++]) : "%s"));
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

export function getLogger(name: string): Logger {
  const emit = (level: LogLevel, msg: string, args: unknown[]) => {
    const formatted = formatMsg(msg, args);
    const prefix = LEVEL_NAMES[level];

    // Console: respect globalLevel, match Python format
    if (level >= globalLevel) {
      const ts = timestamp();
      console.error(`${ts} [${name}] ${prefix} ${formatted}`);
    }

    // File: always write at DEBUG+ when file handler is attached
    if (logFilePath && level >= FILE_LEVEL) {
      try {
        appendFileSync(
          logFilePath,
          `${timestamp()} [${name}] ${prefix} ${formatted}\n`,
          "utf-8",
        );
      } catch {
        // best-effort file logging
      }
    }
  };

  return {
    debug: (msg, ...args) => emit(LogLevel.DEBUG, msg, args),
    info: (msg, ...args) => emit(LogLevel.INFO, msg, args),
    warning: (msg, ...args) => emit(LogLevel.WARNING, msg, args),
    error: (msg, ...args) => emit(LogLevel.ERROR, msg, args),
  };
}
