/**
 * Orchestrator: build LangGraph StateGraph from FlowSpec and execute.
 *
 * LangGraph is fully isolated here — no other module imports langgraph.
 * Responsibilities: DAG construction, fan-out dispatch, state routing.
 */

import { setMaxListeners } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { Annotation, StateGraph, Send, END, START } from "@langchain/langgraph";
import { Checkpoint } from "./checkpoint.js";
import { compare, parseLiteral } from "./condition.js";
import { engineConfigFromEnv, type EngineConfig } from "./engine-config.js";
import { Executor, type StageResult } from "./executor.js";
import { Runner, loadEnvFile } from "./runner.js";
import { resolveModelConfig, type ModelConfig } from "./model-config.js";
import * as report from "./report.js";
import {
  type FilterSpec,
  type FlowSpec,
  type StageSpec,
  StageType,
  resolveAgent,
} from "./spec.js";
import { extractState, getByPathSafe, StateExtractionError } from "./state.js";
import { Workspace } from "./workspace.js";
import { logEvent, debug } from "./logger.js";

export class FlowExecutionError extends Error {
  constructor(
    message: string,
    public readonly stageId: string,
    public readonly exitCode: number,
  ) {
    super(message);
    this.name = "FlowExecutionError";
  }
}


// Simple async semaphore (equivalent to asyncio.Semaphore)
class Semaphore {
  private permits: number;
  private waiters: Array<() => void> = [];
  constructor(permits: number) { this.permits = permits; }
  async acquire(): Promise<void> {
    if (this.permits > 0) { this.permits--; return; }
    return new Promise((resolve) => { this.waiters.push(() => { this.permits--; resolve(); }); });
  }
  release(): void {
    this.permits++;
    if (this.waiters.length > 0) { const next = this.waiters.shift()!; next(); }
  }
}

function filterMapFiles(
  files: string[],
  filter: FilterSpec,
  stageId: string,
): Array<Record<string, any>> {
  const items: Array<Record<string, any>> = [];
  let passed = 0;
  let skipped = 0;

  for (const f of files) {
    let data: Record<string, unknown>;
    try {
      const loaded = yaml.load(readFileSync(f, "utf-8"), { schema: yaml.JSON_SCHEMA });
      if (typeof loaded !== "object" || loaded === null || Array.isArray(loaded)) {
        throw new Error("not a YAML mapping");
      }
      data = loaded as Record<string, unknown>;
    } catch (e) {
      debug("orchestrator", "warning", "[%s] filter: skipping unparseable file %s: %s", stageId, f, e);
      skipped++;
      continue;
    }

    const value = getByPathSafe(data, filter.field);
    if (value === undefined) {
      if (filter.includeMissing) {
        items.push({ _iterate_file: f });
        passed++;
      } else {
        skipped++;
      }
      continue;
    }

    const strValue = String(value);
    let include = false;
    if (filter.match !== undefined) {
      include = strValue === filter.match;
    } else if (filter.notMatch !== undefined) {
      include = strValue !== filter.notMatch;
    } else if (filter.in !== undefined) {
      include = filter.in.includes(strValue);
    } else if (filter.notIn !== undefined) {
      include = !filter.notIn.includes(strValue);
    }

    if (include) {
      items.push({ _iterate_file: f });
      passed++;
    } else {
      skipped++;
    }
  }

  logEvent({
    category: "stage",
    event: "filter",
    stage: stageId,
    glob_total: files.length,
    filter_passed: passed,
    filter_skipped: skipped,
  });

  return items;
}

// ---------------------------------------------------------------------------
// Flow state annotation (LangGraph JS style)
// ---------------------------------------------------------------------------

const FlowStateAnnotation = Annotation.Root({
  extracted: Annotation<Record<string, Record<string, any>>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  stage_results: Annotation<Array<Record<string, any>>>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  route_counts: Annotation<Record<string, number>>({
    reducer: (a, b) => ({ ...a, ...b }),
    default: () => ({}),
  }),
  _route_targets: Annotation<string[]>({
    reducer: (_a, b) => b,
    default: () => [],
  }),
  fork_context: Annotation<{ origin: string; expected: string[]; done: string[] } | undefined>({
    reducer: (a, b) => {
      if (b == null) return undefined;
      if (!a || a.origin !== b.origin || a.expected.join("\0") !== b.expected.join("\0")) return b;
      return { ...b, done: [...new Set([...(a.done ?? []), ...(b.done ?? [])])] };
    },
    default: () => undefined,
  }),
  _iterate_file: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
  }),
  _stage_config: Annotation<Record<string, any>>({
    reducer: (_a, b) => b,
    default: () => ({}),
  }),
});

type FlowState = typeof FlowStateAnnotation.State;

export interface FlowResult {
  stageResults: Array<Record<string, any>>;
  extracted: Record<string, any>;
}

const DEFAULT_RECURSION_LIMIT = 100;

interface RouteDecision {
  targets: string[];
  routeCounts: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export class Orchestrator {
  readonly spec: FlowSpec;
  readonly flowInputs: Record<string, any>;
  readonly resume: boolean;
  readonly maxParallel: number;
  readonly workspace: Workspace;
  readonly checkpoint: Checkpoint;
  readonly runner: Runner;
  readonly workDir: string;
  readonly recursionLimit: number;
  executor: Executor;

  private stageMap: Map<string, StageSpec>;
  private flowTimedOut = false;
  private flowTimeoutTimer?: ReturnType<typeof setTimeout>;
  private flowAbortController?: AbortController;

  constructor(
    spec: FlowSpec,
    flowInputs: Record<string, any>,
    opts: {
      workDir?: string;
      outputDir?: string;
      resume?: boolean;
      maxParallel?: number;
      traceEvents?: boolean;
      recursionLimit?: number;
    } = {},
  ) {
    this.spec = spec;
    this.flowInputs = flowInputs;
    this.resume = opts.resume ?? false;
    this.maxParallel = opts.maxParallel ?? spec.defaultMaxParallel;

    this.workspace = new Workspace(opts.outputDir ?? opts.workDir ?? ".");
    this.workspace.setup();

    this.checkpoint = new Checkpoint(this.workspace.checkpointsDir);

    // Build runner
    const rawEnv = spec.envFile ? loadEnvFile(spec.envFile) : {};
    const modelConfig = resolveModelConfig(
      rawEnv,
      spec.defaultModel,
      spec.flowDir,
      spec.agentsDir,
    );
    const engineConfig = engineConfigFromEnv(rawEnv);
    this.runner = new Runner({
      modelConfig,
      engineConfig,
      systemPromptPath: resolveAgent(spec),
      sessionDir: this.workspace.sessionsDir,
    });

    this.workDir = path.resolve(opts.workDir ?? ".");
    this.recursionLimit = opts.recursionLimit ?? spec.recursionLimit ?? DEFAULT_RECURSION_LIMIT;
    this.executor = new Executor(
      this.runner,
      spec,
      this.workspace,
      this.workDir,
      flowInputs,
      opts.traceEvents ?? false,
      this.flowAbortController?.signal,
    );

    this.stageMap = new Map(spec.stages.map((s) => [s.id, s]));
  }

  get model(): string {
    return this.runner.modelConfig.modelString;
  }

  async run(): Promise<FlowResult> {
    const graph = this.buildGraph();

    // Initial report
    this.refreshReport();

    const initialState: FlowState = {
      extracted: {},
      stage_results: [],
      route_counts: {},
      _route_targets: [],
      fork_context: undefined,
      _iterate_file: "",
      _stage_config: {},
    };

    if (this.resume) {
      const saved = this.checkpoint.loadState();
      initialState.extracted = saved.extracted ?? {};
      initialState.route_counts = saved.route_counts ?? {};
      initialState.fork_context = saved.fork_context ?? undefined;
    }

    if (this.spec.timeout == null) {
      const result = await graph.invoke(initialState, { recursionLimit: this.recursionLimit });
      return {
        stageResults: result.stage_results ?? [],
        extracted: result.extracted ?? {},
      };
    }

    logEvent({ category: "engine", event: "flow_timeout_start", timeout_s: this.spec.timeout });
    this.flowAbortController = new AbortController();
    setMaxListeners(0, this.flowAbortController.signal);
    this.executor = new Executor(
      this.runner,
      this.spec,
      this.workspace,
      this.workDir,
      this.flowInputs,
      false,
      this.flowAbortController.signal,
    );
    try {
      const result = await Promise.race([
        graph.invoke(initialState, { recursionLimit: this.recursionLimit }),
        this.flowTimeoutPromise(this.spec.timeout),
      ]);
      return {
        stageResults: result.stage_results ?? [],
        extracted: result.extracted ?? {},
      };
    } finally {
      this.clearFlowTimeout();
    }
  }

  // ------------------------------------------------------------------
  // Graph construction
  // ------------------------------------------------------------------

  private buildGraph() {
    // LangGraph JS uses literal types for node names; we cast to `any`
    // since node names are dynamic (derived from flow.yaml stage ids).
    const builder: any = new StateGraph(FlowStateAnnotation);
    const stages = this.spec.stages;

    // Phase 1: register nodes
    for (const stage of stages) {
      if (stage.type === StageType.JOIN) {
        this.addJoin(builder, stage);
      } else if (stage.type === StageType.SINGLE) {
        this.addSingle(builder, stage);
      } else {
        this.addFanout(builder, stage);
      }
    }

    // Phase 2: wire edges
    for (const stage of stages) {
      const exitNode = this.exitNode(stage);
      if (stage.routes.length > 0) {
        const targets = new Set<string>();
        for (const r of stage.routes) {
          const targetStage = this.stageMap.get(r.to);
          if (targetStage) {
            targets.add(this.entryNode(targetStage));
          }
        }
        targets.add(END);
        builder.addConditionalEdges(exitNode, this.makeDispatcher(), [
          ...targets,
        ]);
      } else {
        builder.addEdge(exitNode, END);
      }
    }

    // START → first stage
    builder.addEdge(START, this.entryNode(stages[0]));

    return builder.compile();
  }

  private entryNode(stage: StageSpec): string {
    return stage.id;
  }

  private exitNode(stage: StageSpec): string {
    return stage.type !== StageType.SINGLE && stage.type !== StageType.JOIN ? `${stage.id}_done` : stage.id;
  }

  private workerNode(stage: StageSpec): string {
    return `${stage.id}_worker`;
  }

  private makeDispatcher() {
    return (state: FlowState): string | Send[] => {
      const targets = dedupe((state._route_targets ?? []).filter((t) => this.stageMap.has(t)));
      if (targets.length === 0) return END;
      if (targets.length === 1) return this.entryNode(this.stageMap.get(targets[0])!);
      const forkContext = { origin: targets.join("+"), expected: targets, done: [] };
      return targets.map((target) => new Send(this.entryNode(this.stageMap.get(target)!), {
        ...state,
        _route_targets: [],
        fork_context: forkContext,
      }));
    };
  }

  // ------------------------------------------------------------------
  // Single stage
  // ------------------------------------------------------------------

  private addSingle(builder: any, stage: StageSpec): void {
    const self = this;

    builder.addNode(stage.id, async (state: FlowState) => {
      self.throwIfFlowTimedOut(stage.id);

      if (self.resume && self.checkpoint.isDone(stage.id)) {
        logEvent({ category: "stage", event: "stage_skipped", stage: stage.id, reason: "resume" });
        const updates: Record<string, any> = {
          stage_results: [
            { id: stage.id, exit_code: 0, duration_ms: 0, skipped: true },
          ],
        };
        Object.assign(updates, self.forkDoneUpdate(stage.id, state));
        if (stage.routes.length > 0) {
          updates._route_targets = self.resumeRouteDecision(stage, state.extracted ?? {});
        }
        return updates;
      }

      logEvent({ category: "stage", event: "stage_start", stage: stage.id });
      const startedAt = new Date().toISOString().slice(0, 19);
      const result = await self.executor.execute(stage);
      const updates: Record<string, any> = {
        stage_results: [self.resultDict(result, startedAt)],
      };

      updates.extracted = self.mergeStageState(stage, state, result);

      self.checkpoint.markDone(stage.id, updates.stage_results[0]);
      self.refreshReport();

      // Enforce error_strategy: non-zero exit stops the flow unless 'continue'
      if (result.exitCode !== 0 && stage.errorStrategy !== "continue") {
        logEvent({ category: "stage", event: "stage_failed", stage: stage.id, exit_code: result.exitCode });
        throw new FlowExecutionError(
          `Stage '${stage.id}' failed with exit code ${result.exitCode}`,
          stage.id,
          result.exitCode,
        );
      }

      Object.assign(updates, self.forkDoneUpdate(stage.id, state));

      if (stage.routes.length > 0) {
        const decision = self.evaluateRoutes(
          stage,
          updates.extracted,
          state.route_counts ?? {},
        );
        updates.route_counts = decision.routeCounts;
        updates._route_targets = decision.targets;
      }

      return updates;
    });
  }

  // ------------------------------------------------------------------
  // Join stage (engine-only barrier)
  // ------------------------------------------------------------------

  private addJoin(builder: any, stage: StageSpec): void {
    const self = this;

    builder.addNode(stage.id, async (state: FlowState) => {
      self.throwIfFlowTimedOut(stage.id);

      const ctx = state.fork_context;
      const expected = ctx?.expected ?? [];
      const done = ctx?.done ?? [];
      const waiting = expected.length > 0 && !expected.every((id) => done.includes(id));
      if (waiting) {
        debug("orchestrator", "info", "[%s] join waiting for branches: expected=%s done=%s",
          stage.id, expected.join(","), done.join(","));
        return { _route_targets: [] };
      }

      if (self.resume && self.checkpoint.isDone(stage.id)) {
        logEvent({ category: "stage", event: "stage_skipped", stage: stage.id, reason: "resume" });
        const updates: Record<string, any> = {
          stage_results: [
            { id: stage.id, exit_code: 0, duration_ms: 0, skipped: true },
          ],
          fork_context: undefined,
        };
        if (stage.routes.length > 0) {
          updates._route_targets = self.resumeRouteDecision(stage, state.extracted ?? {});
        }
        return updates;
      }

      logEvent({ category: "stage", event: "stage_start", stage: stage.id });
      const startedAt = new Date().toISOString().slice(0, 19);
      const synthetic: StageResult = {
        stageId: stage.id,
        exitCode: 0,
        durationMs: 0,
        outputDir: self.workspace.root,
      };
      const updates: Record<string, any> = {
        stage_results: [self.resultDict(synthetic, startedAt)],
      };
      updates.extracted = self.mergeStageState(stage, state, synthetic);
      self.checkpoint.markDone(stage.id, updates.stage_results[0]);
      self.refreshReport();

      if (stage.routes.length > 0) {
        const decision = self.evaluateRoutes(stage, updates.extracted, state.route_counts ?? {});
        updates.route_counts = decision.routeCounts;
        updates._route_targets = decision.targets;
      }
      updates.fork_context = undefined;
      return updates;
    });
  }

  // ------------------------------------------------------------------
  // Fan-out stage (parallel + map)
  // ------------------------------------------------------------------

  private addFanout(builder: any, stage: StageSpec): void {
    const self = this;
    const gateId = stage.id;
    const workerId = this.workerNode(stage);
    const collectorId = this.exitNode(stage);
    let fanoutStartedAt = "";
    const concurrency = stage.concurrency ?? this.maxParallel;
    const sem = new Semaphore(concurrency);

    // Gate
    builder.addNode(gateId, async (_state: FlowState) => {
      self.throwIfFlowTimedOut(stage.id);
      fanoutStartedAt = new Date().toISOString().slice(0, 19);
      return {};
    });

    // Gate dispatch
    const gateDispatch = (state: FlowState): string | Send[] => {
      if (self.resume && self.checkpoint.isDone(stage.id)) {
        logEvent({ category: "stage", event: "stage_skipped", stage: stage.id, reason: "resume" });
        return collectorId;
      }

      const items = self.resolveItems(stage, state);
      if (items.length === 0) {
        debug("orchestrator", "warning", "[%s] no items to dispatch", stage.id);
        return collectorId;
      }

      logEvent({ category: "stage", event: "dispatch", stage: stage.id, count: items.length });
      return items.map(
        (item) => new Send(workerId, { ...state, ...item }),
      );
    };

    builder.addConditionalEdges(gateId, gateDispatch, [
      workerId,
      collectorId,
    ]);

    // Worker
    builder.addNode(workerId, async (state: FlowState) => {
      self.throwIfFlowTimedOut(stage.id);
      const iterateFile = state._iterate_file ?? "";
      const stageConfig = state._stage_config ?? {};

      // Determine worker label
      let label: string;
      if (stage.type === StageType.PARALLEL) {
        label = stage.tasks[stageConfig.task_index].id;
      } else {
        label = path.basename(iterateFile, path.extname(iterateFile));
      }
      const workerKey = `${stage.id}/${label}`;

      // Resume: skip if this worker already completed
      if (self.resume && self.checkpoint.isDone(workerKey)) {
        logEvent({ category: "stage", event: "stage_skipped", stage: workerKey, reason: "resume" });
        const cached = self.checkpoint.loadDone(workerKey);
        return { stage_results: [cached] };
      }

      // Execute
      let result: StageResult;
      if (stage.type === StageType.PARALLEL) {
        const task = stage.tasks[stageConfig.task_index];
        const outputDir = path.join(self.workspace.root, task.outputSubdir);
        await sem.acquire();
        try {
          result = await self.executor.execute(task, {
            outputDir,
            parentExtensions: stage.extensions,
          });
          debug("orchestrator", "info", "[%s/%s] done: exit=%s duration=%sms", stage.id, label, result.exitCode, result.durationMs);
        } finally {
          sem.release();
        }
      } else {
        const outputDir = path.join(self.workspace.root, stage.id, label);
        await sem.acquire();
        try {
          result = await self.executor.execute(stage, {
            outputDir,
            iterateFile,
          });
          debug("orchestrator", "info", "[%s/%s] done: exit=%s duration=%sms", stage.id, label, result.exitCode, result.durationMs);
        } finally {
          sem.release();
        }
      }

      // Worker-level checkpoint
      const resultEntry = self.resultDict(result);
      self.checkpoint.markDone(workerKey, resultEntry);

      self.refreshReport();
      return { stage_results: [resultEntry] };
    });

    builder.addEdge(workerId, collectorId);

    // Collector
    builder.addNode(collectorId, async (state: FlowState) => {
      self.throwIfFlowTimedOut(stage.id);
      // Resume: skip state extraction, just evaluate routes
      if (self.resume && self.checkpoint.isDone(stage.id)) {
        const updates: Record<string, any> = {
          stage_results: [
            { id: stage.id, exit_code: 0, duration_ms: 0, skipped: true },
          ],
        };
        Object.assign(updates, self.forkDoneUpdate(stage.id, state));
        if (stage.routes.length > 0) {
          updates._route_targets = self.resumeRouteDecision(stage, state.extracted ?? {});
        }
        return updates;
      }

      const updates: Record<string, any> = {};

      const results = state.stage_results ?? [];
      const stageResults = results.filter(
        (r: Record<string, any>) => r.id === stage.id,
      );
      const totalDuration = stageResults.reduce(
        (s: number, r: Record<string, any>) => s + (r.duration_ms ?? 0),
        0,
      );
      const allOk = stageResults.every(
        (r: Record<string, any>) => (r.exit_code ?? 0) === 0,
      );

      const synthetic: StageResult = {
        stageId: stage.id,
        exitCode: allOk ? 0 : 1,
        durationMs: totalDuration,
        outputDir: self.workspace.root,
      };

      updates.extracted = self.mergeStageState(stage, state, synthetic);

      self.checkpoint.markDone(stage.id, {
        exit_code: synthetic.exitCode,
        duration_ms: totalDuration,
        started_at: fanoutStartedAt,
      });
      self.refreshReport();

      Object.assign(updates, self.forkDoneUpdate(stage.id, state));

      if (stage.routes.length > 0) {
        const decision = self.evaluateRoutes(
          stage,
          updates.extracted,
          state.route_counts ?? {},
        );
        updates.route_counts = decision.routeCounts;
        updates._route_targets = decision.targets;
      }

      return updates;
    });
  }

  private resolveItems(
    stage: StageSpec,
    state: FlowState,
  ): Array<Record<string, any>> {
    if (stage.type === StageType.PARALLEL) {
      const extracted = state.extracted ?? {};
      const items: Array<Record<string, any>> = [];
      for (let i = 0; i < stage.tasks.length; i++) {
        const task = stage.tasks[i];
        if (task.when && !evaluateRouteCondition(task.when, extracted)) {
          logEvent({ category: "stage", event: "stage_skipped", stage: `${stage.id}/${task.id}`, reason: `when: ${task.when}` });
          continue;
        }
        items.push({ _stage_config: { task_index: i } });
      }
      return items;
    }

    if (stage.type === StageType.MAP) {
      const files = this.workspace.findFiles(stage.over ?? "");
      if (!stage.filter) {
        return files.map((f) => ({ _iterate_file: f }));
      }
      return filterMapFiles(files, stage.filter, stage.id);
    }

    return [];
  }

  // ------------------------------------------------------------------
  // State merging and route evaluation
  // ------------------------------------------------------------------

  private mergeStageState(
    stage: StageSpec,
    state: FlowState,
    result: StageResult,
  ): Record<string, Record<string, any>> {
    const stageState: Record<string, any> = {
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    };

    if (stage.stateExtract) {
      try {
        const userState = extractState(
          stage.stateExtract.rules,
          this.workspace.root,
        );
        Object.assign(stageState, userState);
      } catch (e) {
        if (e instanceof StateExtractionError) {
          e.stageId = stage.id;
          throw e;
        }
        throw e;
      }
    }

    const newExtracted = { ...(state.extracted ?? {}), [stage.id]: stageState };
    this.checkpoint.saveState({
      extracted: newExtracted,
      route_counts: state.route_counts ?? {},
      fork_context: state.fork_context,
    });
    return newExtracted;
  }

  private evaluateRoutes(
    stage: StageSpec,
    extracted: Record<string, Record<string, any>>,
    routeCounts: Record<string, number>,
  ): RouteDecision {
    const decision = evaluateRouteDecision(stage, extracted, routeCounts, true);
    for (const target of decision.targets) {
      logEvent({ category: "stage", event: "route", stage: stage.id, target });
    }
    if (decision.targets.length === 0) {
      logEvent({ category: "stage", event: "route", stage: stage.id, target: null });
    }
    this.checkpoint.saveState({ extracted, route_counts: decision.routeCounts });
    return decision;
  }

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  private flowTimeoutPromise(timeoutSec: number): Promise<never> {
    return new Promise((_, reject) => {
      this.flowTimeoutTimer = setTimeout(() => {
        this.flowTimedOut = true;
        this.flowAbortController?.abort();
        logEvent({ category: "engine", event: "flow_timeout", timeout_s: timeoutSec });
        reject(new FlowExecutionError(
          `Flow timed out after ${timeoutSec}s`,
          "<flow>",
          -1,
        ));
      }, timeoutSec * 1000);
    });
  }

  private clearFlowTimeout(): void {
    if (this.flowTimeoutTimer) clearTimeout(this.flowTimeoutTimer);
    this.flowTimeoutTimer = undefined;
    this.flowAbortController = undefined;
  }

  private throwIfFlowTimedOut(stageId: string): void {
    if (!this.flowTimedOut) return;
    throw new FlowExecutionError(
      `Flow timed out after ${this.spec.timeout}s`,
      stageId,
      -1,
    );
  }

  /**
   * Evaluate routes for a resume-skipped stage.
   * Checks conditions against saved extracted state but does NOT
   * increment route_counts or check max_loops — the route was already
   * validated and taken in the original run.
   */
  private resumeRouteDecision(
    stage: StageSpec,
    extracted: Record<string, Record<string, any>>,
  ): string[] {
    const decision = evaluateRouteDecision(stage, extracted, {}, false);
    for (const target of decision.targets) {
      logEvent({ category: "stage", event: "route", stage: stage.id, target });
    }
    if (decision.targets.length === 0) {
      logEvent({ category: "stage", event: "route", stage: stage.id, target: null });
    }
    return decision.targets;
  }

  private forkDoneUpdate(stageId: string, state: FlowState): Record<string, any> {
    const ctx = state.fork_context;
    if (!ctx?.expected?.includes(stageId)) return {};
    const next = { ...ctx, done: dedupe([...(ctx.done ?? []), stageId]) };
    this.checkpoint.saveState({
      extracted: state.extracted ?? {},
      route_counts: state.route_counts ?? {},
      fork_context: next,
    });
    return { fork_context: next };
  }

  private refreshReport(): void {
    report.refresh(this.spec, this.workspace);
  }

  private resultDict(
    result: StageResult,
    startedAt = "",
  ): Record<string, any> {
    return {
      id: result.stageId,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
      output_dir: result.outputDir,
      session_file: result.sessionFile,
      started_at: startedAt,
    };
  }
}

// ---------------------------------------------------------------------------
// Route / task-when condition evaluation
// ---------------------------------------------------------------------------

export function evaluateRouteDecision(
  stage: Pick<StageSpec, "id" | "routes">,
  extracted: Record<string, Record<string, any>>,
  routeCounts: Record<string, number>,
  incrementCounts: boolean,
): RouteDecision {
  const counts = { ...routeCounts };
  const selected: string[] = [];

  const eligible = (route: { to: string; when: string | undefined; maxLoops: number | undefined }): boolean => {
    if (route.maxLoops) {
      const key = `${stage.id}→${route.to}`;
      if ((counts[key] ?? 0) >= route.maxLoops) {
        debug("orchestrator", "info", "[%s] route to '%s' exhausted (%s/%s)",
          stage.id, route.to, counts[key], route.maxLoops);
        return false;
      }
    }
    return true;
  };

  for (const route of stage.routes) {
    if (!route.when) continue;
    if (!evaluateRouteCondition(route.when, extracted)) continue;
    if (!eligible(route)) continue;
    if (incrementCounts) {
      const key = `${stage.id}→${route.to}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    selected.push(route.to);
  }

  if (selected.length > 0) return { targets: dedupe(selected), routeCounts: counts };

  for (const route of stage.routes) {
    if (route.when) continue;
    if (!eligible(route)) continue;
    if (incrementCounts) {
      const key = `${stage.id}→${route.to}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return { targets: [route.to], routeCounts: counts };
  }

  return { targets: [], routeCounts: counts };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function evaluateRouteCondition(
  expr: string,
  extracted: Record<string, Record<string, any>>,
): boolean {
  // Python split(None, 2): split into at most 3 parts, third keeps remainder
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 3) {
    debug("orchestrator", "warning", "Invalid condition: '%s'", expr);
    return false;
  }
  const [lhs, op, ...rest] = parts;
  const rawValue = rest.join(" ");

  if (!lhs.includes(".")) {
    debug("orchestrator", "warning", "Condition must use 'stage_id.key' format: '%s'", expr);
    return false;
  }

  const dotIdx = lhs.indexOf(".");
  const stageId = lhs.slice(0, dotIdx);
  const key = lhs.slice(dotIdx + 1);
  const actual = extracted[stageId]?.[key] ?? null;
  const expected = parseLiteral(rawValue);

  try {
    return compare(actual, op, expected);
  } catch {
    debug("orchestrator", "warning", "Unknown operator in condition: '%s'", op);
    return false;
  }
}
