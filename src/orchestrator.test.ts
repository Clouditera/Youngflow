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

  it("uses filtered glob counts for route selection", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-route-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outDir = path.join(dir, "out");
    tmpDirs.push(dir);
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
    mkdirSync(path.join(outDir, "hypotheses"), { recursive: true });
    writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n");
    writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n");
    writeFileSync(path.join(outDir, "hypotheses", "HYP-001.md"), "---\nstatus: pending\n---\n# pending\n");
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: investigate",
      "    skills: [test-skill]",
      "    state:",
      "      confirmed_count:",
      "        glob: hypotheses/HYP-*.md",
      "        filter:",
      "          field: status",
      "          match: confirmed-risk",
      "    routes:",
      "      - to: verify_affirm",
      "        when: investigate.confirmed_count > 0",
      "      - to: report",
      "  - id: verify_affirm",
      "    type: map",
      "    skills: [test-skill]",
      "    over: hypotheses/HYP-*.md",
      "    filter:",
      "      field: status",
      "      match: confirmed-risk",
      "  - id: report",
      "    skills: [test-skill]",
    ].join("\n"));
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, { work_dir: dir, output_dir: outDir }, { workDir: dir, outputDir: outDir, recursionLimit: 50 });
    const executed: string[] = [];
    (orch as any).executor = {
      execute: async (stage: any) => {
        executed.push(stage.id);
        return { stageId: stage.id, exitCode: 0, durationMs: 1, outputDir: outDir };
      },
    };

    await orch.run();

    expect(executed).toEqual(["investigate", "report"]);
  });

  it("preserves concurrent route targets per source stage", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-concurrent-routes-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outDir = path.join(dir, "out");
    tmpDirs.push(dir);
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
    writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n");
    writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n");
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: start",
      "    skills: [test-skill]",
      "    state:",
      "      route_left:",
      "        glob: left.flag",
      "      route_right:",
      "        glob: right.flag",
      "    routes:",
      "      - to: left",
      "        when: start.route_left > 0",
      "      - to: right",
      "        when: start.route_right > 0",
      "  - id: left",
      "    skills: [test-skill]",
      "    routes:",
      "      - to: final_left",
      "  - id: right",
      "    skills: [test-skill]",
      "    routes:",
      "      - to: final_right",
      "  - id: final_left",
      "    skills: [test-skill]",
      "  - id: final_right",
      "    skills: [test-skill]",
    ].join("\n"));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "left.flag"), "1\n");
    writeFileSync(path.join(outDir, "right.flag"), "1\n");
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, { work_dir: dir, output_dir: outDir }, { workDir: dir, outputDir: outDir, recursionLimit: 50 });
    const executed: string[] = [];
    (orch as any).executor = {
      execute: async (stage: any) => {
        executed.push(stage.id);
        return { stageId: stage.id, exitCode: 0, durationMs: 1, outputDir: outDir };
      },
    };

    await orch.run();

    expect(executed).toEqual(expect.arrayContaining(["left", "right", "final_left", "final_right"]));
  });
});

describe("map stage filter", () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function makeMapFilterFlow(filterYaml?: string): { dir: string; flowPath: string; outDir: string } {
    const dir = path.join(os.tmpdir(), `youngflow-map-filter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outDir = path.join(dir, "out");
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
    mkdirSync(path.join(outDir, "findings"), { recursive: true });
    writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n");
    writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n");
    writeFileSync(path.join(outDir, "findings", "pending.yaml"), "metadata:\n  review_status: pending\n");
    writeFileSync(path.join(outDir, "findings", "new.yaml"), "metadata:\n  review_status: new\n");
    writeFileSync(path.join(outDir, "findings", "reproduced.yaml"), "metadata:\n  review_status: reproduced\n");
    writeFileSync(path.join(outDir, "findings", "missing.yaml"), "metadata: {}\n");
    writeFileSync(path.join(outDir, "findings", "corrupt.yaml"), "metadata: [\n");
    const lines = [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: review",
      "    type: map",
      "    skills: [test-skill]",
      "    over: findings/*.yaml",
      "    concurrency: 1",
    ];
    if (filterYaml) {
      lines.push("    filter:", ...filterYaml.split("\n").map((line) => `      ${line}`));
    }
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, lines.join("\n"));
    return { dir, flowPath, outDir };
  }

  async function runMapFilter(filterYaml?: string): Promise<string[]> {
    const { dir, flowPath, outDir } = makeMapFilterFlow(filterYaml);
    tmpDirs.push(dir);
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, { work_dir: dir, output_dir: outDir }, { workDir: dir, outputDir: outDir, recursionLimit: 50 });
    const executed: string[] = [];
    (orch as any).executor = {
      execute: async (stage: any, options: any) => {
        executed.push(path.basename(options.iterateFile, ".yaml"));
        return { stageId: stage.id, exitCode: 0, durationMs: 1, outputDir: options.outputDir };
      },
    };
    await orch.run();
    return executed.sort();
  }

  it("keeps existing behavior when no filter is configured", async () => {
    expect(await runMapFilter()).toEqual(["corrupt", "missing", "new", "pending", "reproduced"]);
  });

  it("supports match and skips corrupt YAML", async () => {
    expect(await runMapFilter("field: metadata.review_status\nmatch: pending")).toEqual(["pending"]);
  });

  it("supports not_match", async () => {
    expect(await runMapFilter("field: metadata.review_status\nnot_match: reproduced")).toEqual(["new", "pending"]);
  });

  it("supports in", async () => {
    expect(await runMapFilter("field: metadata.review_status\nin: [pending, new]")).toEqual(["new", "pending"]);
  });

  it("supports not_in", async () => {
    expect(await runMapFilter("field: metadata.review_status\nnot_in: [reproduced]")).toEqual(["new", "pending"]);
  });

  it("includes missing fields only when include_missing is true", async () => {
    expect(await runMapFilter("field: metadata.review_status\nmatch: pending\ninclude_missing: true")).toEqual(["missing", "pending"]);
    expect(await runMapFilter("field: metadata.review_status\nmatch: pending\ninclude_missing: false")).toEqual(["pending"]);
  });

  async function runMapFilterWithFiles(
    over: string,
    filterYaml: string,
    files: Record<string, string>,
  ): Promise<string[]> {
    const dir = path.join(os.tmpdir(), `youngflow-map-filter-extra-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const outDir = path.join(dir, "out");
    tmpDirs.push(dir);
    mkdirSync(path.join(dir, "agents"), { recursive: true });
    mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
    mkdirSync(path.join(outDir, "findings"), { recursive: true });
    writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n");
    writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n");
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(outDir, "findings", name), content);
    }
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: review",
      "    type: map",
      "    skills: [test-skill]",
      `    over: ${over}`,
      "    concurrency: 1",
      "    filter:",
      ...filterYaml.split("\n").map((line) => `      ${line}`),
    ].join("\n"));
    const spec = parseFlow(flowPath);
    const orch = new Orchestrator(spec, { work_dir: dir, output_dir: outDir }, { workDir: dir, outputDir: outDir, recursionLimit: 50 });
    const executed: string[] = [];
    (orch as any).executor = {
      execute: async (_stage: any, options: any) => {
        executed.push(path.parse(options.iterateFile).name);
        return { stageId: "review", exitCode: 0, durationMs: 1, outputDir: options.outputDir };
      },
    };
    await orch.run();
    return executed.sort();
  }

  it("supports markdown frontmatter match and not_match", async () => {
    const files = {
      "pending.md": "---\nmetadata:\n  review_status: pending\n---\n# Pending\n",
      "done.md": "---\nmetadata:\n  review_status: done\n---\n# Done\n",
      "plain.md": "# No frontmatter\nmetadata:\n  review_status: pending\n",
    };
    expect(await runMapFilterWithFiles("findings/*.md", "field: metadata.review_status\nmatch: pending", files)).toEqual(["pending"]);
    expect(await runMapFilterWithFiles("findings/*.md", "field: metadata.review_status\nnot_match: done", files)).toEqual(["pending"]);
  });

  it("supports markdown frontmatter include_missing", async () => {
    expect(await runMapFilterWithFiles("findings/*.md", "field: metadata.review_status\nmatch: pending\ninclude_missing: true", {
      "missing.md": "---\nmetadata: {}\n---\n# Missing\n",
      "pending.md": "---\nmetadata:\n  review_status: pending\n---\n# Pending\n",
    })).toEqual(["missing", "pending"]);
  });

  it("supports JSON object filtering", async () => {
    expect(await runMapFilterWithFiles("findings/*.json", "field: metadata.review_status\nin: [pending, new]", {
      "pending.json": JSON.stringify({ metadata: { review_status: "pending" } }),
      "new.json": JSON.stringify({ metadata: { review_status: "new" } }),
      "done.json": JSON.stringify({ metadata: { review_status: "done" } }),
    })).toEqual(["new", "pending"]);
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
