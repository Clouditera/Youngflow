import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { evaluateRouteDecision, Orchestrator } from "./orchestrator.js";
import { parseFlow } from "./spec.js";

function makeFlow(recursionLimit?: number): { dir: string; flowPath: string } {
  const dir = path.join(os.tmpdir(), `youngflow-orch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n");
  writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n");
  const lines = [
    'version: "1.0"',
    ...(recursionLimit ? [`recursion_limit: ${recursionLimit}`] : []),
    "defaults:",
    "  agent: agent.md",
    "stages:",
    "  - id: first",
    "    skills: [test-skill]",
  ];
  const flowPath = path.join(dir, "flow.yaml");
  writeFileSync(flowPath, lines.join("\n"));
  return { dir, flowPath };
}

describe("Orchestrator recursion limit", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("defaults selected LangGraph recursion limit to 100", () => {
    const { dir, flowPath } = makeFlow();
    tmpDirs.push(dir);
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, {}, { outputDir: path.join(dir, "out") });
    expect(orch.recursionLimit).toBe(100);
  });

  it("uses flow recursion_limit when present", () => {
    const { dir, flowPath } = makeFlow(150);
    tmpDirs.push(dir);
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, {}, { outputDir: path.join(dir, "out") });
    expect(orch.recursionLimit).toBe(150);
  });

  it("uses CLI override over flow recursion_limit", () => {
    const { dir, flowPath } = makeFlow(150);
    tmpDirs.push(dir);
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, {}, { outputDir: path.join(dir, "out"), recursionLimit: 300 });
    expect(orch.recursionLimit).toBe(300);
  });
});

describe("evaluateRouteDecision", () => {
  const stage: any = {
    id: "discovery",
    routes: [
      { to: "research", when: "discovery.inv_pending > 0", maxLoops: undefined },
      { to: "argument", when: "discovery.hyp_pending > 0", maxLoops: undefined },
      { to: "report", when: undefined, maxLoops: undefined },
    ],
  };

  it("selects all matching conditional routes", () => {
    const decision = evaluateRouteDecision(stage, { discovery: { inv_pending: 1, hyp_pending: 1 } }, {}, true);
    expect(decision.targets).toEqual(["research", "argument"]);
  });

  it("does not select fallback when a conditional route matches", () => {
    const decision = evaluateRouteDecision(stage, { discovery: { inv_pending: 1, hyp_pending: 0 } }, {}, true);
    expect(decision.targets).toEqual(["research"]);
  });

  it("selects first fallback when no conditional route matches", () => {
    const decision = evaluateRouteDecision(stage, { discovery: { inv_pending: 0, hyp_pending: 0 } }, {}, true);
    expect(decision.targets).toEqual(["report"]);
  });

  it("deduplicates selected targets", () => {
    const dupStage: any = {
      id: "s",
      routes: [
        { to: "next", when: "s.a > 0", maxLoops: undefined },
        { to: "next", when: "s.b > 0", maxLoops: undefined },
      ],
    };
    const decision = evaluateRouteDecision(dupStage, { s: { a: 1, b: 1 } }, {}, true);
    expect(decision.targets).toEqual(["next"]);
  });

  it("omits exhausted routes", () => {
    const loopStage: any = { id: "join", routes: [{ to: "discovery", when: undefined, maxLoops: 1 }] };
    const decision = evaluateRouteDecision(loopStage, {}, { "join→discovery": 1 }, true);
    expect(decision.targets).toEqual([]);
  });
});

function makeRoutingFlow(files: { inv: boolean; hyp: boolean }): { dir: string; flowPath: string; outDir: string } {
  const dir = path.join(os.tmpdir(), `youngflow-route-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n");
  writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n");
  const outDir = path.join(dir, "out");
  if (files.inv) {
    mkdirSync(path.join(outDir, "investigations", "pending"), { recursive: true });
    writeFileSync(path.join(outDir, "investigations", "pending", "INV-001.yaml"), "id: INV-001\n");
  }
  if (files.hyp) {
    mkdirSync(path.join(outDir, "hypotheses", "pending"), { recursive: true });
    writeFileSync(path.join(outDir, "hypotheses", "pending", "HYP-001.yaml"), "id: HYP-001\n");
  }
  const flowPath = path.join(dir, "flow.yaml");
  writeFileSync(flowPath, [
    'version: "1.0"',
    "defaults:",
    "  agent: agent.md",
    "stages:",
    "  - id: discovery",
    "    skills: [test-skill]",
    "    state:",
    "      inv_pending:",
    "        glob: investigations/pending/INV-*.yaml",
    "      hyp_pending:",
    "        glob: hypotheses/pending/HYP-*.yaml",
    "    routes:",
    "      - to: research",
    "        when: discovery.inv_pending > 0",
    "      - to: argument",
    "        when: discovery.hyp_pending > 0",
    "      - to: report",
    "  - id: research",
    "    skills: [test-skill]",
    "    routes:",
    "      - to: joiner",
    "  - id: argument",
    "    skills: [test-skill]",
    "    routes:",
    "      - to: joiner",
    "  - id: joiner",
    "    type: join",
    "    routes:",
    "      - to: report",
    "  - id: report",
    "    skills: [test-skill]",
  ].join("\n"));
  return { dir, flowPath, outDir };
}

async function runRoutingFixture(files: { inv: boolean; hyp: boolean }): Promise<{ executed: string[]; outDir: string; dir: string }> {
  const { dir, flowPath, outDir } = makeRoutingFlow(files);
  const spec = parseFlow(flowPath);
  const orch = new Orchestrator(spec, { work_dir: dir, output_dir: outDir }, { workDir: dir, outputDir: outDir, recursionLimit: 100 });
  const executed: string[] = [];
  (orch as any).executor = {
    execute: async (stage: any) => {
      executed.push(stage.id);
      return { stageId: stage.id, exitCode: 0, durationMs: 1, outputDir: outDir };
    },
  };
  await orch.run();
  return { executed, outDir, dir };
}

describe("multi-target routing + join integration", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("runs both matching branches and joins before report", async () => {
    const result = await runRoutingFixture({ inv: true, hyp: true });
    tmpDirs.push(result.dir);
    expect(result.executed).toContain("discovery");
    expect(result.executed).toContain("research");
    expect(result.executed).toContain("argument");
    expect(result.executed.filter((id) => id === "report")).toHaveLength(1);
    const reportIndex = result.executed.indexOf("report");
    expect(reportIndex).toBeGreaterThan(result.executed.indexOf("research"));
    expect(reportIndex).toBeGreaterThan(result.executed.indexOf("argument"));
    const state = readFileSync(path.join(result.outDir, ".youngflow", "checkpoints", "flow_state.yaml"), "utf-8");
    expect(state).not.toContain("fork_context");
  });

  it("runs only the matching branch when one queue is pending", async () => {
    const result = await runRoutingFixture({ inv: true, hyp: false });
    tmpDirs.push(result.dir);
    expect(result.executed).toContain("research");
    expect(result.executed).not.toContain("argument");
    expect(result.executed).toContain("report");
  });

  it("uses fallback when no conditional route matches", async () => {
    const result = await runRoutingFixture({ inv: false, hyp: false });
    tmpDirs.push(result.dir);
    expect(result.executed).toEqual(["discovery", "report"]);
  });

  it("resumes partial fan-out by skipping done branch and completing unfinished branch", async () => {
    const { dir, flowPath, outDir } = makeRoutingFlow({ inv: true, hyp: true });
    tmpDirs.push(dir);
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, { work_dir: dir, output_dir: outDir }, { workDir: dir, outputDir: outDir, resume: true, recursionLimit: 100 });
    orch.checkpoint.markDone("discovery", { id: "discovery", exit_code: 0, duration_ms: 1 });
    orch.checkpoint.markDone("research", { id: "research", exit_code: 0, duration_ms: 1 });
    orch.checkpoint.saveState({ extracted: { discovery: { inv_pending: 1, hyp_pending: 1 } }, route_counts: {} });
    const executed: string[] = [];
    (orch as any).executor = {
      execute: async (stage: any) => {
        executed.push(stage.id);
        return { stageId: stage.id, exitCode: 0, durationMs: 1, outputDir: outDir };
      },
    };

    await orch.run();

    expect(executed).toContain("argument");
    expect(executed).toContain("report");
    expect(executed).not.toContain("research");
  });
});

describe("flows/demo-join deterministic validation", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function demoFlowPath(): string {
    return path.resolve("flows/demo-join/flow.yaml");
  }

  async function runDemo(markers: { inv: boolean; hyp: boolean }): Promise<{ executed: string[]; stageIds: string[]; outDir: string }> {
    const outDir = path.join(os.tmpdir(), `youngflow-demo-join-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    tmpDirs.push(outDir);
    if (markers.inv) {
      mkdirSync(path.join(outDir, "investigations", "pending"), { recursive: true });
      writeFileSync(path.join(outDir, "investigations", "pending", "INV-001.txt"), "inv\n");
    }
    if (markers.hyp) {
      mkdirSync(path.join(outDir, "hypotheses", "pending"), { recursive: true });
      writeFileSync(path.join(outDir, "hypotheses", "pending", "HYP-001.txt"), "hyp\n");
    }
    const spec = parseFlow(demoFlowPath());
    const orch = new Orchestrator(spec, { work_dir: process.cwd(), output_dir: outDir }, { workDir: process.cwd(), outputDir: outDir, recursionLimit: 50 });
    const executed: string[] = [];
    (orch as any).executor = {
      execute: async (stage: any) => {
        executed.push(stage.id);
        return { stageId: stage.id, exitCode: 0, durationMs: 1, outputDir: outDir };
      },
    };
    const result = await orch.run();
    return { executed, stageIds: result.stageResults.map((r: any) => r.id), outDir };
  }

  it("demo flow parses and contains explicit join stage", () => {
    const spec = parseFlow(demoFlowPath());
    expect(spec.stages.map((s) => `${s.id}:${s.type}`)).toEqual([
      "discovery:single",
      "research:map",
      "argument:map",
      "join_branches:join",
      "report:single",
    ]);
  });

  it("demo flow dispatches both branches, joins engine-only, then reports once", async () => {
    const result = await runDemo({ inv: true, hyp: true });
    expect(result.executed).toContain("discovery");
    expect(result.executed).toContain("research");
    expect(result.executed).toContain("argument");
    expect(result.executed.filter((id) => id === "report")).toHaveLength(1);
    expect(result.executed).not.toContain("join_branches"); // join is engine-only; executor is not called
    expect(result.stageIds).toContain("join_branches");
    const reportIndex = result.executed.indexOf("report");
    expect(reportIndex).toBeGreaterThan(result.executed.indexOf("research"));
    expect(reportIndex).toBeGreaterThan(result.executed.indexOf("argument"));
  });

  it("demo flow fallback runs report directly when no pending markers exist", async () => {
    const result = await runDemo({ inv: false, hyp: false });
    expect(result.executed).toEqual(["discovery", "report"]);
    expect(result.stageIds).not.toContain("join_branches");
  });
});
