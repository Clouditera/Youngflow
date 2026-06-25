import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor, itemKeyFor } from "./executor.js";
import { StageType, type FlowSpec } from "./spec.js";
import { Workspace } from "./workspace.js";
import type { RunConfig, RunResult } from "./runner.js";

function makeSpec(dir: string, overrides: Partial<FlowSpec> = {}): FlowSpec {
  return {
    sourcePath: path.join(dir, "flow.yaml"),
    flowDir: dir,
    timeout: undefined,
    recursionLimit: undefined,
    agentsDir: path.join(dir, "agents"),
    skillsDir: path.join(dir, "skills"),
    tasksDir: path.join(dir, "tasks"),
    extensionsDir: undefined,
    schemasDir: undefined,
    templatesDir: undefined,
    envFile: undefined,
    modelsJsonPath: undefined,
    defaultModel: "anthropic/claude-sonnet-4-5:high",
    defaultMaxParallel: 3,
    defaultAgent: undefined,
    defaultTools: undefined,
    defaultExcludeTools: undefined,
    compaction: undefined,
    defaultExtensions: [],
    defaultEnv: {},
    inputs: [],
    stages: [],
    ...overrides,
  };
}

function makeStage(overrides: Record<string, any> = {}): any {
  return {
    id: "scan",
    name: "scan",
    type: StageType.SINGLE,
    skills: [],
    task: undefined,
    prompt: "First ${work_dir}",
    session: { reuse: false, prompt: undefined, compactAt: undefined },
    tools: undefined,
    excludeTools: undefined,
    timeout: 1800,
    model: undefined,
    agent: undefined,
    concurrency: undefined,
    errorStrategy: "stop",
    extensions: [],
    env: undefined,
    routes: [],
    tasks: [],
    over: undefined,
    overSource: undefined,
    filter: undefined,
    stateExtract: undefined,
    ...overrides,
  };
}

function ok(sessionFile?: string): RunResult {
  return {
    exitCode: 0,
    durationMs: 1,
    sessionFile,
    toolCalls: [],
    turns: 1,
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    tokensTotal: 0,
    apiErrors: 0,
    retries: 0,
    finalHasContent: true,
  };
}

class CapturingRunner {
  modelConfig = { compactionExtensionPath: "/tmp/.pi-agent/yf-compaction.ts" };
  configs: RunConfig[] = [];
  async run(config: RunConfig): Promise<RunResult> {
    this.configs.push(config);
    return ok(config.sessionFile);
  }
}

describe("Executor session reuse", () => {
  it("uses a stable session path when reuseSession is true", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-session-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});
      const stage = makeStage();

      await executor.execute(stage, { reuseSession: true });
      await executor.execute(stage, { reuseSession: true });

      expect(runner.configs[0].sessionFile).toBe(path.join(ws.sessionsDir, "scan", "session.jsonl"));
      expect(runner.configs[1].sessionFile).toBe(runner.configs[0].sessionFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps timestamped session paths when reuseSession is false", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-session-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage(), { reuseSession: false });

      expect(runner.configs[0].sessionFile).toMatch(/sessions\/scan\/\d{8}-\d{6}\/session\.jsonl$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses session.prompt only on reuse turns", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-session-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      mkdirSync(path.join(dir, "tasks"), { recursive: true });
      writeFileSync(path.join(dir, "tasks", "task.md"), "TASK BODY\n");
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, { target: "demo" });
      const stage = makeStage({
        task: "task.md",
        prompt: "First ${flow_inputs.target}",
        session: { reuse: true, prompt: "Continue ${flow_inputs.target}", compactAt: undefined },
      });

      await executor.execute(stage, { reuseSession: true });
      expect(runner.configs[0].task).toBe("TASK BODY\n\n---\n\n# Runtime Context\n\nFirst demo");

      const stableSession = path.join(ws.sessionsDir, "scan", "session.jsonl");
      mkdirSync(path.dirname(stableSession), { recursive: true });
      writeFileSync(stableSession, "{}\n");
      await executor.execute(stage, { reuseSession: true });

      expect(runner.configs[1].task).toBe("Continue demo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives bounded stable keys from arbitrary iterate_item strings", () => {
    expect(itemKeyFor("BUG-HYP-R7-I4-H3")).toMatch(/^BUG-HYP-R7-I4-H3-[0-9a-f]{8}$/);
    expect(itemKeyFor("  ///  ")).toMatch(/^[0-9a-f]{8}$/);
    expect(itemKeyFor("A".repeat(200)).length).toBeLessThan(50);
    expect(itemKeyFor("task A")).not.toBe(itemKeyFor("task B"));
    expect(itemKeyFor("task A")).toBe(itemKeyFor("task A"));
  });

  it("uses itemKey in stable map session paths", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-session-map-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage(), { reuseSession: true, iterateFile: path.join(dir, "A.yaml") });
      await executor.execute(makeStage(), { reuseSession: true, iterateFile: path.join(dir, "B.yaml") });

      expect(runner.configs[0].sessionFile).toBe(path.join(ws.sessionsDir, "scan", "A", "session.jsonl"));
      expect(runner.configs[1].sessionFile).toBe(path.join(ws.sessionsDir, "scan", "B", "session.jsonl"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses hashed iterate_item key and injects iterate_item into prompt", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-session-item-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});
      const item = "BUG-HYP-R7-I4-H3: reproduce with params";
      const key = itemKeyFor(item);

      await executor.execute(makeStage({ prompt: "Item=${iterate_item}" }), { reuseSession: true, iterateItem: item });

      expect(runner.configs[0].sessionFile).toBe(path.join(ws.sessionsDir, "scan", key, "session.jsonl"));
      expect(runner.configs[0].task).toBe(`Item=${item}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses own stage tools before defaults", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-tools-own-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir, { defaultTools: ["read", "bash"] }), ws, dir, {});

      await executor.execute(makeStage({ tools: ["read", "coverage"] }));

      expect(runner.configs[0].tools).toEqual(["read", "coverage"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses default tools when stage tools are omitted", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-tools-default-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir, { defaultTools: ["read", "bash"] }), ws, dir, {});

      await executor.execute(makeStage());

      expect(runner.configs[0].tools).toEqual(["read", "bash"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel task inherits parentTools when it has no own tools", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-tools-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir, { defaultTools: ["read"] }), ws, dir, {});

      await executor.execute(makeStage({ id: "task-a" }), { parentTools: ["read", "coverage"] });

      expect(runner.configs[0].tools).toEqual(["read", "coverage"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel task own tools override parentTools", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-tools-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage({ id: "task-a", tools: ["read"] }), { parentTools: ["read", "coverage"] });

      expect(runner.configs[0].tools).toEqual(["read"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes stage own exclude_tools with effective tools", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-exclude-own-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir, { defaultTools: ["read", "bash", "coverage"] }), ws, dir, {});

      await executor.execute(makeStage({ excludeTools: ["coverage"] }));

      expect(runner.configs[0].tools).toEqual(["read", "bash", "coverage"]);
      expect(runner.configs[0].excludeTools).toEqual(["coverage"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses default exclude_tools when own and parent are omitted", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-exclude-default-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir, { defaultExcludeTools: ["coverage"] }), ws, dir, {});

      await executor.execute(makeStage());

      expect(runner.configs[0].excludeTools).toEqual(["coverage"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel task inherits parentExcludeTools when it has no own exclude_tools", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-exclude-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage({ id: "task-a" }), { parentExcludeTools: ["coverage"] });

      expect(runner.configs[0].excludeTools).toEqual(["coverage"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects compaction extension and threshold env when session compact_at is configured", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage({ session: { reuse: true, prompt: undefined, compactAt: 0.7 } }));

      expect(runner.configs[0].extensions).toContain("/tmp/.pi-agent/yf-compaction.ts");
      expect(runner.configs[0].envExtra.YOUNGFLOW_COMPACT_AT).toBe("0.7");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not inject compaction extension when compact_at is omitted", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-no-compact-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage());

      expect(runner.configs[0].extensions).not.toContain("/tmp/.pi-agent/yf-compaction.ts");
      expect(runner.configs[0].envExtra.YOUNGFLOW_COMPACT_AT).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel task inherits parent compact_at when task compact_at is omitted", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-compact-parent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage({ id: "task-a" }), { parentCompactAt: 0.6 });

      expect(runner.configs[0].extensions).toContain("/tmp/.pi-agent/yf-compaction.ts");
      expect(runner.configs[0].envExtra.YOUNGFLOW_COMPACT_AT).toBe("0.6");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel task own compact_at overrides parent compact_at", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-compact-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage({ id: "task-a", session: { reuse: false, prompt: undefined, compactAt: 0.8 } }), { parentCompactAt: 0.6 });

      expect(runner.configs[0].envExtra.YOUNGFLOW_COMPACT_AT).toBe("0.8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("parallel task own exclude_tools override parentExcludeTools", async () => {
    const dir = path.join(os.tmpdir(), `youngflow-exec-exclude-task-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    try {
      const ws = new Workspace(path.join(dir, "out"));
      ws.setup();
      const runner = new CapturingRunner();
      const executor = new Executor(runner as any, makeSpec(dir), ws, dir, {});

      await executor.execute(makeStage({ id: "task-a", excludeTools: ["bash"] }), { parentExcludeTools: ["coverage"] });

      expect(runner.configs[0].excludeTools).toEqual(["bash"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
