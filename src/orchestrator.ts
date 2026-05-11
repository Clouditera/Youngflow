/**
 * Orchestrator: build LangGraph StateGraph from FlowSpec and execute.
 *
 * LangGraph is fully isolated here — no other module imports langgraph.
 * Responsibilities: DAG construction, fan-out dispatch, state routing.
 */

import { setMaxListeners } from "node:events";
import path from "node:path";
import { Annotation, StateGraph, Send, END, START } from "@langchain/langgraph";
import { Checkpoint } from "./checkpoint.js";
import { compare, parseLiteral } from "./condition.js";
import { engineConfigFromEnv, type EngineConfig } from "./engine-config.js";
import { Executor, type StageResult } from "./executor.js";
import { Runner, loadEnvFile } from "./runner.js";
import { resolveModelConfig, type ModelConfig } from "./model-config.js";
import * as report from "./report.js";
import {
  type FlowSpec,
  type StageSpec,
  StageType,
  resolveAgent,
} from "./spec.js";
import { extractState, StateExtractionError } from "./state.js";
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
  _route_decision: Annotation<string>({
    reducer: (_a, b) => b,
    default: () => "",
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
      _route_decision: "",
      _iterate_file: "",
      _stage_config: {},
    };

    if (this.resume) {
      const saved = this.checkpoint.loadState();
      initialState.extracted = saved.extracted ?? {};
      initialState.route_counts = saved.route_counts ?? {};
    }

    if (this.spec.timeout == null) {
      const result = await graph.invoke(initialState);
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
        graph.invoke(initialState),
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
      if (stage.type === StageType.SINGLE) {
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
    return stage.type !== StageType.SINGLE ? `${stage.id}_done` : stage.id;
  }

  private workerNode(stage: StageSpec): string {
    return `${stage.id}_worker`;
  }

  private makeDispatcher() {
    return (state: FlowState): string => {
      const decision = state._route_decision ?? "";
      if (decision && this.stageMap.has(decision)) {
        return this.entryNode(this.stageMap.get(decision)!);
      }
      return END;
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
        if (stage.routes.length > 0) {
          updates._route_decision = self.resumeRouteDecision(
            stage, state.extracted ?? {},
          );
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

      if (stage.routes.length > 0) {
        const [decision, counts] = self.evaluateRoutes(
          stage,
          updates.extracted,
          state.route_counts ?? {},
        );
        updates.route_counts = counts;
        updates._route_decision = decision;
      }

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
        const outputDir = self.workspace.ensureDir(task.outputSubdir);
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
        const outputDir = self.workspace.ensureDir(stage.id, label);
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
        if (stage.routes.length > 0) {
          updates._route_decision = self.resumeRouteDecision(
            stage, state.extracted ?? {},
          );
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

      if (stage.routes.length > 0) {
        const [decision, counts] = self.evaluateRoutes(
          stage,
          updates.extracted,
          state.route_counts ?? {},
        );
        updates.route_counts = counts;
        updates._route_decision = decision;
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
      return files.map((f) => ({ _iterate_file: f }));
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
    this.checkpoint.saveState({ extracted: newExtracted });
    return newExtracted;
  }

  private evaluateRoutes(
    stage: StageSpec,
    extracted: Record<string, Record<string, any>>,
    routeCounts: Record<string, number>,
  ): [string, Record<string, number>] {
    const counts = { ...routeCounts };

    for (const route of stage.routes) {
      if (route.when && !evaluateRouteCondition(route.when, extracted)) {
        continue;
      }
      if (route.maxLoops) {
        const key = `${stage.id}→${route.to}`;
        if ((counts[key] ?? 0) >= route.maxLoops) {
          debug("orchestrator", "info", "[%s] route to '%s' exhausted (%s/%s)",
            stage.id, route.to, counts[key], route.maxLoops);
          continue;
        }
      }
      // Route matched
      const key = `${stage.id}→${route.to}`;
      counts[key] = (counts[key] ?? 0) + 1;
      logEvent({ category: "stage", event: "route", stage: stage.id, target: route.to });
      this.checkpoint.saveState({ extracted, route_counts: counts });
      return [route.to, counts];
    }

    logEvent({ category: "stage", event: "route", stage: stage.id, target: null });
    return ["", counts];
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
  ): string {
    for (const route of stage.routes) {
      if (route.when && !evaluateRouteCondition(route.when, extracted)) continue;
      logEvent({ category: "stage", event: "route", stage: stage.id, target: route.to });
      return route.to;
    }
    logEvent({ category: "stage", event: "route", stage: stage.id, target: null });
    return "";
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
