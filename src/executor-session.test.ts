import { describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Executor } from "./executor.js";
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
    session: { reuse: false, prompt: undefined },
    tools: undefined,
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
        session: { reuse: true, prompt: "Continue ${flow_inputs.target}" },
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
});
