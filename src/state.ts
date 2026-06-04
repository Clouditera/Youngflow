/**
 * State extraction from stage artifacts.
 *
 * Rule types:
 *   {file, field}             → scalar value from YAML
 *   {file, keys_of, where}   → filtered keys from YAML dict
 *   {glob}                    → file count (lenient)
 *
 * file rules are strict contracts; glob rules are lenient.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import fg from "fast-glob";
const { globSync } = fg;
import yaml from "js-yaml";
import { evaluateExpr } from "./condition.js";
import { debug } from "./logger.js";

export class StateExtractionError extends Error {
  key: string;
  reason: string;
  stageId?: string;

  constructor(key: string, reason: string, stageId?: string) {
    const label = stageId ? `${stageId}.${key}` : key;
    super(`state '${label}': ${reason}`);
    this.name = "StateExtractionError";
    this.key = key;
    this.reason = reason;
    this.stageId = stageId;
  }
}

export function extractState(
  rules: Record<string, Record<string, unknown>>,
  baseDir: string,
): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  for (const [key, rule] of Object.entries(rules)) {
    if (typeof rule !== "object" || rule === null) {
      throw new StateExtractionError(
        key,
        `rule must be an object, got ${typeof rule}`,
      );
    }

    if ("glob" in rule) {
      state[key] = evalGlob(rule as Record<string, string>, baseDir);
    } else if ("file" in rule) {
      try {
        state[key] = evalFile(rule as Record<string, string>, baseDir);
      } catch (e) {
        if (e instanceof StateExtractionError) throw e;
        if (e instanceof Error && e.message.includes("ENOENT")) {
          throw new StateExtractionError(key, `file not found: ${e.message}`);
        }
        if (e instanceof TypeError) {
          throw new StateExtractionError(key, String(e));
        }
        throw new StateExtractionError(key, `${(e as Error).constructor?.name ?? "Error"}: ${e}`);
      }
    } else {
      throw new StateExtractionError(key, "rule has no data source (file/glob)");
    }
  }

  if (state && Object.keys(state).length > 0) {
    debug("state", "info", "Extracted state: %s", JSON.stringify(state));
  }
  return state;
}

function evalGlob(rule: Record<string, string>, baseDir: string): number {
  const pattern = rule.glob;
  return globSync(pattern, { cwd: baseDir }).length;
}

function evalFile(rule: Record<string, string>, baseDir: string): unknown {
  const fileRel = rule.file;
  const filePath = path.join(baseDir, fileRel);
  if (!existsSync(filePath)) {
    throw new Error(`ENOENT: file not found: ${filePath}`);
  }

  const data = yaml.load(readFileSync(filePath, "utf-8"), { schema: yaml.JSON_SCHEMA });
  if (typeof data !== "object" || data === null) {
    throw new Error(`Expected YAML mapping at ${filePath}`);
  }
  const dict = data as Record<string, unknown>;

  if ("field" in rule) {
    return getByPath(dict, rule.field);
  }

  if ("keys_of" in rule) {
    const parent = getByPath(dict, rule.keys_of);
    if (typeof parent !== "object" || parent === null || Array.isArray(parent)) {
      throw new TypeError(`keys_of target is not a dict: ${rule.keys_of}`);
    }
    const parentDict = parent as Record<string, unknown>;
    const where = rule.where;
    if (where) {
      return Object.entries(parentDict)
        .filter(([, v]) => {
          if (typeof v !== "object" || v === null) return false;
          const vDict = v as Record<string, unknown>;
          return evaluateExpr(where, (k) => vDict[k]);
        })
        .map(([k]) => k);
    }
    return Object.keys(parentDict);
  }

  throw new Error(`file rule must have 'field' or 'keys_of': ${JSON.stringify(rule)}`);
}

export function getByPath(data: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = data;
  for (const part of dotPath.split(".")) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Cannot traverse non-object at '${part}' in '${dotPath}'`);
    }
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) {
      throw new Error(`Key '${part}' not found in '${dotPath}'`);
    }
  }
  return current;
}

export function getByPathSafe(data: Record<string, unknown>, dotPath: string): unknown | undefined {
  try {
    return getByPath(data, dotPath);
  } catch {
    return undefined;
  }
}
