import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { debug } from "./logger.js";

export interface FilterSpec {
  readonly field: string;
  readonly match: string | undefined;
  readonly notMatch: string | undefined;
  readonly in: readonly string[] | undefined;
  readonly notIn: readonly string[] | undefined;
  readonly includeMissing: boolean;
}

export function parseFilterSpec(raw: Record<string, any> | undefined): FilterSpec | undefined {
  if (!raw) return undefined;
  return {
    field: raw.field,
    match: raw.match ?? undefined,
    notMatch: raw.not_match ?? raw.notMatch ?? undefined,
    in: raw.in ? [...raw.in] : undefined,
    notIn: raw.not_in ? [...raw.not_in] : raw.notIn ? [...raw.notIn] : undefined,
    includeMissing: raw.include_missing ?? raw.includeMissing ?? false,
  };
}

export function selectFiles(files: string[], filter: FilterSpec | undefined, stageId: string): string[] {
  if (!filter) return [...files];
  const selected: string[] = [];
  for (const file of files) {
    try {
      const data = parseFilterData(file);
      if (matchesFilter(data, filter)) selected.push(file);
    } catch (e) {
      debug("orchestrator", "warning", "[%s] filter: skipping unparseable file %s: %s", stageId, file, e);
    }
  }
  return selected;
}

export function parseFilterData(filePath: string): Record<string, unknown> {
  const content = readFileSync(filePath, "utf-8");
  let loaded: unknown;

  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json") {
    loaded = JSON.parse(content);
  } else if (ext === ".md" || ext === ".markdown") {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error("markdown frontmatter not found");
    loaded = yaml.load(frontmatter[1], { schema: yaml.JSON_SCHEMA });
  } else {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    loaded = yaml.load(frontmatter ? frontmatter[1] : content, { schema: yaml.JSON_SCHEMA });
  }

  if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
    throw new Error("not a YAML/JSON mapping");
  }
  return loaded as Record<string, unknown>;
}

export function matchesFilter(data: Record<string, unknown>, filter: FilterSpec): boolean {
  const value = getByPathSafe(data, filter.field);
  if (value === undefined) return filter.includeMissing;

  const strValue = String(value);
  if (filter.match !== undefined) return strValue === filter.match;
  if (filter.notMatch !== undefined) return strValue !== filter.notMatch;
  if (filter.in !== undefined) return filter.in.includes(strValue);
  if (filter.notIn !== undefined) return !filter.notIn.includes(strValue);
  return false;
}

function getByPathSafe(data: Record<string, unknown>, dotPath: string): unknown | undefined {
  let current: unknown = data;
  for (const part of dotPath.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
    if (current === undefined) return undefined;
  }
  return current;
}
