/**
 * Checkpoint: persist and restore stage completion state.
 *
 * Pure persistence — no reverse dependencies, no report refresh.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
const { globSync } = fg;
import yaml from "js-yaml";
import { logEvent, debug } from "./logger.js";

const STATE_FILE = "flow_state.yaml";

export class Checkpoint {
  readonly dir: string;

  constructor(checkpointsDir: string) {
    this.dir = checkpointsDir;
    mkdirSync(this.dir, { recursive: true });
  }

  markDone(stageId: string, result: Record<string, any>): void {
    const marker = {
      ...result,
      stage: stageId,
      status: (result.exit_code ?? 0) === 0 ? "success" : "failed",
      completed_at: new Date().toISOString().replace(/\.\d+Z$/, ""),
    };
    const p = path.join(this.dir, `${stageId}.done.yaml`);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, yaml.dump(marker), "utf-8");
    logEvent({ category: "engine", event: "checkpoint_save", stage: stageId });
  }

  isDone(stageId: string): boolean {
    const p = path.join(this.dir, `${stageId}.done.yaml`);
    if (!existsSync(p)) return false;
    try {
      const data = yaml.load(readFileSync(p, "utf-8")) as Record<string, any>;
      // Only treat as done if status is success; failed stages must re-run on resume
      return data?.status === "success";
    } catch {
      return false;
    }
  }

  loadDone(stageId: string): Record<string, any> {
    const p = path.join(this.dir, `${stageId}.done.yaml`);
    if (!existsSync(p)) return {};
    try {
      const data = yaml.load(readFileSync(p, "utf-8")) as Record<string, any>;
      if (typeof data !== "object" || data === null) return {};
      // Strip checkpoint metadata, return the original result dict
      const { stage: _s, status: _st, completed_at: _c, ...result } = data;
      return result;
    } catch {
      return {};
    }
  }

  completedStages(): string[] {
    const files = globSync("*.done.yaml", { cwd: this.dir });
    return files
      .sort()
      .map((f) => f.replace(".done.yaml", ""));
  }

  saveState(state: Record<string, any>): void {
    const saveable: Record<string, any> = {};
    for (const [k, v] of Object.entries(state)) {
      if (!k.startsWith("_") && k !== "stage_results") {
        saveable[k] = v;
      }
    }
    const p = path.join(this.dir, STATE_FILE);
    writeFileSync(p, yaml.dump(saveable), "utf-8");
    debug("checkpoint", "debug", "Flow state saved: %s", JSON.stringify(saveable));
  }

  loadState(): Record<string, any> {
    const p = path.join(this.dir, STATE_FILE);
    if (!existsSync(p)) return {};
    try {
      const data = yaml.load(readFileSync(p, "utf-8"));
      const result = typeof data === "object" && data !== null
        ? (data as Record<string, any>)
        : {};
      logEvent({ category: "engine", event: "checkpoint_load", data: JSON.stringify(result) });
      return result;
    } catch (e) {
      debug("checkpoint", "warning", "Failed to load flow state: %s", e);
      return {};
    }
  }

  clean(): void {
    const files = globSync("*", { cwd: this.dir });
    for (const f of files) {
      unlinkSync(path.join(this.dir, f));
    }
    debug("checkpoint", "info", "Checkpoints cleaned");
  }
}
