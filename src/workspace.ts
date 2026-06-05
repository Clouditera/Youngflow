/**
 * Workspace: directory management for a flow run.
 *
 * Separates engine operational data (.youngflow/) from flow business outputs.
 *
 *   output_dir/
 *   ├── .youngflow/          ← engine internal
 *   │   ├── logs/
 *   │   ├── sessions/
 *   │   ├── checkpoints/
 *   │   └── flow-report.html
 *   └── [flow outputs]
 */

import { mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
const { globSync } = fg;

const ENGINE_DIR = ".youngflow";
const SAFE_SEGMENT_RE = /[^A-Za-z0-9._-]+/g;
const ACTIVE_ENGINE_ENTRIES = [
  "checkpoints",
  "logs",
  "sessions",
  "flow-report.html",
  "youngflow.log",
  "run.yaml",
  "execution.jsonl",
];

export class Workspace {
  readonly root: string;
  private readonly engine: string;

  constructor(workDir: string) {
    this.root = path.resolve(workDir);
    this.engine = path.join(this.root, ENGINE_DIR);
  }

  setup(): void {
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(this.logsDir, { recursive: true });
    mkdirSync(this.checkpointsDir, { recursive: true });
  }

  ensureDir(...parts: string[]): string {
    const d = path.join(this.root, ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  }

  findFiles(pattern: string): string[] {
    return globSync(pattern, { cwd: this.root, absolute: true }).sort();
  }

  sessionPath(stageId: string, itemKey?: string): string {
    const now = new Date();
    const ts =
      now.getUTCFullYear().toString() +
      String(now.getUTCMonth() + 1).padStart(2, "0") +
      String(now.getUTCDate()).padStart(2, "0") +
      "-" +
      String(now.getUTCHours()).padStart(2, "0") +
      String(now.getUTCMinutes()).padStart(2, "0") +
      String(now.getUTCSeconds()).padStart(2, "0");

    const parts = [this.safeSegment(stageId)];
    if (itemKey) parts.push(this.safeSegment(itemKey));
    parts.push(ts);
    return path.join(this.sessionsDir, ...parts, "session.jsonl");
  }

  private safeSegment(value: string): string {
    let s = value.replace(/\//g, "_").trim();
    s = s.replace(SAFE_SEGMENT_RE, "-");
    s = s.replace(/^[-._]+|[-._]+$/g, "");
    return s || "item";
  }

  activeEngineEntries(): string[] {
    return ACTIVE_ENGINE_ENTRIES.filter((entry) => {
      try {
        statSync(path.join(this.engine, entry));
        return true;
      } catch {
        return false;
      }
    });
  }

  archiveActiveRun(runId: string): string | undefined {
    const entries = this.activeEngineEntries();
    if (entries.length === 0) return undefined;

    const archiveDir = path.join(this.runsDir, runId);
    try {
      statSync(archiveDir);
      throw new Error(`Run archive already exists: ${archiveDir}`);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }

    mkdirSync(archiveDir, { recursive: true });
    for (const entry of entries) {
      renameSync(path.join(this.engine, entry), path.join(archiveDir, entry));
    }
    return archiveDir;
  }

  // Engine operational directories

  get engineDir(): string {
    return this.engine;
  }

  get runsDir(): string {
    return path.join(this.engine, "runs");
  }

  get runMetadataPath(): string {
    return path.join(this.engine, "run.yaml");
  }

  get sessionsDir(): string {
    return path.join(this.engine, "sessions");
  }

  get logsDir(): string {
    return path.join(this.engine, "logs");
  }

  get checkpointsDir(): string {
    return path.join(this.engine, "checkpoints");
  }

  get reportPath(): string {
    return path.join(this.engine, "flow-report.html");
  }

  get flowLog(): string {
    return path.join(this.engine, "youngflow.log");
  }

  get executionLogPath(): string {
    return path.join(this.engine, "execution.jsonl");
  }
}
