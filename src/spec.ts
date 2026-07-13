/**
 * Flow specification: YAML → readonly types.
 *
 * Pure data layer. No side effects, no I/O after parsing.
 * Includes schema validation via Ajv + semantic checks.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import Ajv from "ajv";
import { debug } from "./logger.js";
import { parseFilterSpec, type FilterSpec } from "./map-filter.js";

declare const __dirname: string;

function specDir(): string {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return __dirname;
  }
}

// ---------------------------------------------------------------------------
// Types (all readonly)
// ---------------------------------------------------------------------------

export enum StageType {
  SINGLE = "single",
  PARALLEL = "parallel",
  MAP = "map",
  JOIN = "join",
}

export interface FlowInputSpec {
  readonly name: string;
  readonly description: string;
  readonly type: string; // path | str | list
  readonly required: boolean;
  readonly default: string | undefined;
}

export interface StateExtractSpec {
  readonly rules: Record<string, Record<string, unknown>>;
}

export type OverSpec =
  | { readonly kind: "glob"; readonly pattern: string }
  | { readonly kind: "yaml"; readonly file: string; readonly path: string };

export interface CompactionSpec {
  readonly enabled: boolean | undefined;
  readonly reserveTokens: number | undefined;
  readonly keepRecentTokens: number | undefined;
}

export interface SessionSpec {
  readonly reuse: boolean;
  readonly prompt: string | undefined;
  readonly compactAt: number | undefined;
}

export interface TaskSpec {
  readonly id: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly task: string | undefined;
  readonly prompt: string;
  readonly session: SessionSpec;
  readonly tools: readonly string[] | undefined;
  readonly excludeTools: readonly string[] | undefined;
  readonly timeout: number;
  readonly outputSubdir: string;
  readonly when: string | undefined;
}

export interface RouteSpec {
  readonly to: string;
  readonly when: string | undefined;
  readonly maxLoops: number | undefined;
}

export interface StageSpec {
  readonly id: string;
  readonly name: string;
  readonly type: StageType;
  readonly skills: readonly string[];
  readonly task: string | undefined;
  readonly prompt: string;
  readonly session: SessionSpec;
  readonly tools: readonly string[] | undefined;
  readonly excludeTools: readonly string[] | undefined;
  readonly timeout: number;
  readonly model: string | undefined;
  readonly agent: string | undefined;
  readonly concurrency: number | undefined;
  readonly errorStrategy: string;
  readonly extensions: readonly string[];
  readonly env: Record<string, string> | undefined;
  readonly routes: readonly RouteSpec[];
  readonly tasks: readonly TaskSpec[];
  readonly over: string | undefined;
  readonly overSource: OverSpec | undefined;
  readonly filter: FilterSpec | undefined;
  readonly stateExtract: StateExtractSpec | undefined;
}

export interface FlowSpec {
  readonly sourcePath: string;
  readonly flowDir: string;
  readonly timeout: number | undefined;
  readonly recursionLimit: number | undefined;
  readonly agentsDir: string;
  readonly skillsDir: string;
  readonly tasksDir: string;
  readonly extensionsDir: string | undefined;
  readonly schemasDir: string | undefined;
  readonly templatesDir: string | undefined;
  readonly envFile: string | undefined;
  readonly modelsJsonPath: string | undefined;
  readonly defaultModel: string;
  readonly defaultMaxParallel: number;
  readonly defaultAgent: string | undefined;
  readonly defaultTools: readonly string[] | undefined;
  readonly defaultExcludeTools: readonly string[] | undefined;
  readonly compaction: CompactionSpec | undefined;
  readonly defaultExtensions: readonly string[];
  readonly defaultEnv: Record<string, string>;
  readonly inputs: readonly FlowInputSpec[];
  readonly stages: readonly StageSpec[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export function parseFlow(
  yamlPath: string,
  untilStage?: string,
): FlowSpec {
  yamlPath = path.resolve(yamlPath);
  const flowDir = path.dirname(yamlPath);
  const raw = yaml.load(readFileSync(yamlPath, "utf-8")) as Record<string, any>;

  validateFlow(raw, flowDir);

  // Artifacts
  const artifacts = raw.artifacts ?? {};
  const agentsDir = path.join(flowDir, artifacts.agents ?? "agents");
  const skillsDir = path.join(flowDir, artifacts.skills ?? "skills");
  const tasksDir = path.join(flowDir, artifacts.tasks ?? "tasks");
  const extensionsDir = artifacts.extensions
    ? path.join(flowDir, artifacts.extensions)
    : undefined;
  const schemasDir = artifacts.schemas
    ? path.join(flowDir, artifacts.schemas)
    : undefined;
  const templatesDir = artifacts.templates
    ? path.join(flowDir, artifacts.templates)
    : undefined;
  const envFileRel = artifacts.env_file ?? ".env";
  const envPath = path.join(flowDir, envFileRel);
  const envFile = existsSync(envPath) ? envPath : undefined;
  const modelsJsonPath = artifacts.models_json
    ? path.join(flowDir, artifacts.models_json)
    : undefined;

  // Defaults
  const defaults = raw.defaults ?? {};
  const defaultModel = defaults.model ?? "anthropic/claude-sonnet-4-5:high";
  const defaultMaxParallel = defaults.max_parallel ?? 3;
  const defaultAgent = defaults.agent ?? undefined;
  const defaultTools = defaults.tools ? [...defaults.tools] : undefined;
  const defaultExcludeTools = defaults.exclude_tools ? [...defaults.exclude_tools] : undefined;
  const compaction = parseCompaction(defaults.compaction);
  const defaultExtensions: string[] = defaults.extensions
    ? [...defaults.extensions]
    : [];
  const defaultEnv: Record<string, string> = { ...(defaults.env ?? {}) };

  // Inputs
  const inputs = parseInputs(raw.inputs ?? {});

  // Stages
  let allStages = (raw.stages ?? []).map(parseStage);
  if (untilStage) {
    const idx = allStages.findIndex((s: StageSpec) => s.id === untilStage);
    if (idx === -1) {
      throw new Error(
        `Unknown stage '${untilStage}'. Available: ${allStages.map((s: StageSpec) => s.id).join(", ")}`,
      );
    }
    allStages = allStages.slice(0, idx + 1);
    debug("spec", "info", "Truncated flow at '%s' (%s stages)", untilStage, allStages.length);
  }

  return {
    sourcePath: yamlPath,
    flowDir,
    timeout: raw.timeout ?? undefined,
    recursionLimit: raw.recursion_limit ?? undefined,
    agentsDir,
    skillsDir,
    tasksDir,
    extensionsDir,
    schemasDir,
    templatesDir,
    envFile,
    modelsJsonPath,
    defaultModel,
    defaultMaxParallel,
    defaultAgent,
    defaultTools,
    defaultExcludeTools,
    compaction,
    defaultExtensions,
    defaultEnv,
    inputs,
    stages: allStages,
  };
}

// ---------------------------------------------------------------------------
// Internal parsers
// ---------------------------------------------------------------------------

function parseInputs(raw: Record<string, any>): FlowInputSpec[] {
  return Object.entries(raw).map(([name, spec]) => {
    const s = typeof spec === "object" && spec !== null ? spec : {};
    return {
      name,
      description: s.description ?? "",
      type: s.type ?? "str",
      required: s.required ?? false,
      default: s.default,
    };
  });
}

function parseStage(raw: Record<string, any>): StageSpec {
  const stageType = (raw.type ?? "single") as StageType;
  const stateExtract: StateExtractSpec | undefined = raw.state
    ? { rules: raw.state }
    : undefined;

  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    type: stageType,
    skills: raw.skills ?? [],
    task: raw.task ?? undefined,
    prompt: raw.prompt ?? "",
    session: parseSession(raw.session),
    tools: raw.tools ? [...raw.tools] : undefined,
    excludeTools: raw.exclude_tools ? [...raw.exclude_tools] : undefined,
    timeout: raw.timeout ?? 1800,
    model: raw.model ?? undefined,
    agent: raw.agent ?? undefined,
    concurrency: raw.concurrency ?? undefined,
    errorStrategy: raw.error_strategy ?? "stop",
    extensions: raw.extensions ?? [],
    env: raw.env ? { ...raw.env } : undefined,
    routes: (raw.routes ?? []).map(parseRoute),
    tasks: (raw.tasks ?? []).map(parseTask),
    over: typeof raw.over === "string" ? raw.over : undefined,
    overSource: parseOver(raw.over),
    filter: parseFilterSpec(raw.filter),
    stateExtract,
  };
}

function parseOver(raw: any): OverSpec | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return { kind: "glob", pattern: raw };
  return { kind: "yaml", file: raw.yaml, path: raw.path };
}

function parseRoute(raw: Record<string, any>): RouteSpec {
  return {
    to: raw.to,
    when: raw.when ?? undefined,
    maxLoops: raw.max_loops ?? undefined,
  };
}

function parseCompaction(raw: Record<string, any> | undefined): CompactionSpec | undefined {
  if (!raw) return undefined;
  return {
    enabled: raw.enabled ?? undefined,
    reserveTokens: raw.reserve_tokens ?? undefined,
    keepRecentTokens: raw.keep_recent_tokens ?? undefined,
  };
}

function parseSession(raw: Record<string, any> | undefined): SessionSpec {
  return {
    reuse: raw?.reuse ?? false,
    prompt: raw?.prompt ?? undefined,
    compactAt: raw?.compact_at ?? undefined,
  };
}

function parseTask(raw: Record<string, any>): TaskSpec {
  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    skills: raw.skills ?? [],
    task: raw.task ?? undefined,
    prompt: raw.prompt ?? "",
    session: parseSession(raw.session),
    tools: raw.tools ? [...raw.tools] : undefined,
    excludeTools: raw.exclude_tools ? [...raw.exclude_tools] : undefined,
    timeout: raw.timeout ?? 1800,
    outputSubdir: raw.output_subdir ?? raw.id,
    when: raw.when ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function resolveAgent(
  spec: FlowSpec,
  agentName?: string,
): string {
  const name = agentName ?? spec.defaultAgent;
  if (name) {
    const p = path.join(spec.agentsDir, name);
    if (existsSync(p)) return p;
    throw new Error(`Agent not found: ${name} (in ${spec.agentsDir})`);
  }

  // Fallback: first .md in agents dir
  if (existsSync(spec.agentsDir)) {
    const files = readdirSync(spec.agentsDir).sort();
    for (const f of files) {
      if (f.endsWith(".md")) return path.join(spec.agentsDir, f);
    }
  }
  throw new Error(`No agent prompt found in ${spec.agentsDir}`);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class FlowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowValidationError";
  }
}

export function validateFlow(raw: Record<string, any>, flowDir: string): void {
  const errors: string[] = [];

  validateSchema(raw, errors);
  validateSemantics(raw, flowDir, errors);

  if (errors.length > 0) {
    const msg =
      `flow.yaml validation failed (${errors.length} error(s)):\n` +
      errors.map((e) => `  - ${e}`).join("\n");
    throw new FlowValidationError(msg);
  }

  debug("spec", "info", "flow.yaml validation passed");
}

function validateSchema(raw: Record<string, any>, errors: string[]): void {
  const schemaPath = path.join(specDir(), "flow.schema.yaml");
  if (!existsSync(schemaPath)) {
    debug("spec", "warning", "Schema file not found: %s", schemaPath);
    return;
  }

  try {
    const schema = yaml.load(readFileSync(schemaPath, "utf-8")) as Record<
      string,
      any
    >;
    const AjvClass = (Ajv as any).default ?? Ajv;
    const ajv = new AjvClass({ allErrors: true, strict: false });
    const validate = ajv.compile(schema);
    if (!validate(raw) && validate.errors) {
      for (const err of validate.errors) {
        const p = err.instancePath || "(root)";
        errors.push(`[schema] ${p}: ${err.message}`);
      }
    }
  } catch {
    // Schema validation is best-effort
  }
}

function validateSemantics(
  raw: Record<string, any>,
  flowDir: string,
  errors: string[],
): void {
  const stages: any[] = raw.stages ?? [];
  if (stages.length === 0) {
    errors.push("[semantic] stages: at least one stage is required");
    return;
  }

  const stageIds = new Set<string>();
  const allTaskIds = new Set<string>();

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const sid = stage.id ?? "";
    const prefix = `stages[${i}] (${sid || "?"})`;

    if (stageIds.has(sid)) {
      errors.push(`[semantic] ${prefix}: duplicate stage id '${sid}'`);
    }
    stageIds.add(sid);

    const stageType = stage.type ?? "single";

    if (stageType === "parallel") {
      const tasks = stage.tasks ?? [];
      if (tasks.length === 0) {
        errors.push(`[semantic] ${prefix}: tasks is required for type 'parallel'`);
      }
      for (let j = 0; j < tasks.length; j++) {
        const task = tasks[j];
        const tid = task.id ?? "";
        const tprefix = `${prefix}.tasks[${j}] (${tid || "?"})`;
        if (allTaskIds.has(tid)) {
          errors.push(`[semantic] ${tprefix}: duplicate task id '${tid}'`);
        }
        allTaskIds.add(tid);
      }
    }

    if (stageType === "map" && !stage.over) {
      errors.push(`[semantic] ${prefix}: 'over' is required for type 'map'`);
    }

    if (stage.filter && typeof stage.over === "object" && stage.over !== null) {
      errors.push(`[semantic] ${prefix}: filter is only supported with file-glob 'over'`);
    }

    if (stage.filter) {
      const ops = [stage.filter.match, stage.filter.not_match, stage.filter.in, stage.filter.not_in]
        .filter((v) => v !== undefined);
      if (ops.length === 0) {
        errors.push(`[semantic] ${prefix}: filter requires one of match/not_match/in/not_in`);
      }
      if (ops.length > 1) {
        errors.push(`[semantic] ${prefix}: filter match/not_match/in/not_in are mutually exclusive`);
      }
    }

    // Verify task file
    if (stage.task) {
      const artifacts = raw.artifacts ?? {};
      const tasksDir = path.join(flowDir, artifacts.tasks ?? "tasks");
      if (!existsSync(path.join(tasksDir, stage.task))) {
        errors.push(
          `[semantic] ${prefix}: task file not found: ${stage.task} (in ${tasksDir})`,
        );
      }
    }

    // Verify agent file
    if (stage.agent) {
      const agentsDir = path.join(
        flowDir,
        (raw.artifacts ?? {}).agents ?? "agents",
      );
      if (!existsSync(path.join(agentsDir, stage.agent))) {
        errors.push(
          `[semantic] ${prefix}: agent file not found: ${stage.agent} (in ${agentsDir})`,
        );
      }
    }

    // Verify skills directories
    const artifacts = raw.artifacts ?? {};
    const skillsDir = path.join(flowDir, artifacts.skills ?? "skills");
    for (const skillName of stage.skills ?? []) {
      if (!existsSync(path.join(skillsDir, skillName))) {
        errors.push(`[semantic] ${prefix}: skill dir not found: ${skillName}`);
      }
    }
  }

  // Verify agents directory
  const artifacts = raw.artifacts ?? {};
  if (artifacts.models_json && !existsSync(path.join(flowDir, artifacts.models_json))) {
    errors.push(`[semantic] artifacts.models_json not found: ${artifacts.models_json}`);
  }
  const agentsDir = path.join(flowDir, artifacts.agents ?? "agents");
  if (existsSync(agentsDir)) {
    const files = readdirSync(agentsDir);
    if (!files.some((f) => f.endsWith(".md"))) {
      errors.push(`[semantic] agents dir has no .md files: ${agentsDir}`);
    }
  } else {
    errors.push(`[semantic] agents dir not found: ${agentsDir}`);
  }

  // Validate routes
  const stageOrder = new Map<string, number>();
  stages.forEach((s: any, idx: number) => stageOrder.set(s.id ?? "", idx));

  for (let i = 0; i < stages.length; i++) {
    const stage = stages[i];
    const sid = stage.id ?? "";
    const prefix = `stages[${i}] (${sid})`;
    for (let j = 0; j < (stage.routes ?? []).length; j++) {
      const route = stage.routes[j];
      const target = route.to ?? "";
      if (!stageOrder.has(target)) {
        errors.push(
          `[semantic] ${prefix}.routes[${j}]: target '${target}' not found`,
        );
      } else if (
        stageOrder.get(target)! <= i &&
        !route.max_loops
      ) {
        errors.push(
          `[semantic] ${prefix}.routes[${j}]: backward route to '${target}' requires max_loops`,
        );
      }
    }
  }
}
