import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveEnvRefs, resolveModelEnvReferences } from "./env-interpolation.js";
import { Orchestrator } from "./orchestrator.js";
import { parseFlow, StageType, type FlowSpec } from "./spec.js";

function stage(id: string, model?: string): any {
  return {
    id,
    name: id,
    type: StageType.SINGLE,
    skills: [],
    task: undefined,
    prompt: "",
    session: { reuse: false, prompt: undefined, compactAt: undefined },
    tools: undefined,
    excludeTools: undefined,
    timeout: 1800,
    model,
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
  };
}

function spec(overrides: Partial<FlowSpec> = {}): FlowSpec {
  return {
    sourcePath: "/flow/flow.yaml",
    flowDir: "/flow",
    timeout: undefined,
    recursionLimit: undefined,
    agentsDir: "/flow/agents",
    skillsDir: "/flow/skills",
    tasksDir: "/flow/tasks",
    extensionsDir: undefined,
    schemasDir: undefined,
    templatesDir: undefined,
    envFile: "/flow/.env",
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
    stages: [stage("scan")],
    ...overrides,
  };
}

function makeFakePi(dir: string, stdout: string, stderr = "", exitCode = 0): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const piPath = path.join(binDir, "pi");
  writeFileSync(piPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${exitCode});\n`, "utf-8");
  chmodSync(piPath, 0o755);
  return binDir;
}

describe("resolveModelEnvReferences", () => {
  it("resolves defaults.model and stages[].model from env", () => {
    const original = spec({
      defaultModel: "${env.YF_DEFAULT_MODEL}",
      stages: [stage("scan", "${env.YF_FAST_MODEL}")],
    });
    const resolved = resolveModelEnvReferences(original, {
      YF_DEFAULT_MODEL: "zai/glm-5.1:medium",
      YF_FAST_MODEL: "deepseek/deepseek-v4-flash",
    });

    expect(resolved.defaultModel).toBe("zai/glm-5.1:medium");
    expect(resolved.stages[0].model).toBe("deepseek/deepseek-v4-flash");
  });

  it("supports partial and multiple env refs", () => {
    expect(resolveEnvRefs("${env.PROVIDER}/${env.MODEL}:high", "defaults.model", {
      PROVIDER: "zai",
      MODEL: "glm-5.1",
    })).toBe("zai/glm-5.1:high");
  });

  it("uses caller-provided env precedence", () => {
    const merged = { MODEL: "from-process", MODEL_FROM_ENV_FILE: "unused", ...{ MODEL: "from-env-file" } };
    expect(resolveEnvRefs("provider/${env.MODEL}", "defaults.model", merged)).toBe("provider/from-env-file");
  });

  it("fails with field path for missing defaults env var", () => {
    expect(() => resolveModelEnvReferences(spec({ defaultModel: "${env.YF_DEFAULT_MODEL}" }), {}))
      .toThrow(/Missing env var YF_DEFAULT_MODEL for defaults\.model/);
  });

  it("fails with field path for missing stage env var", () => {
    expect(() => resolveModelEnvReferences(spec({ stages: [stage("scan", "${env.YF_FAST_MODEL}")] }), {}))
      .toThrow(/Missing env var YF_FAST_MODEL for stages\[scan\]\.model/);
  });

  it("fails for empty env var", () => {
    expect(() => resolveEnvRefs("${env.EMPTY}", "defaults.model", { EMPTY: "" }))
      .toThrow(/Missing env var EMPTY for defaults\.model/);
  });

  it("leaves literal model values unchanged and returns the original spec", () => {
    const original = spec();
    const resolved = resolveModelEnvReferences(original, {});
    expect(resolved).toBe(original);
    expect(resolved.defaultModel).toBe("anthropic/claude-sonnet-4-5:high");
  });
});

describe("model env interpolation integration", () => {
  it("resolves models before precheck", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "youngflow-env-model-"));
    const oldPath = process.env.PATH;
    try {
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
      writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n", "utf-8");
      writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n", "utf-8");
      writeFileSync(path.join(dir, ".env"), [
        "YF_DEFAULT_MODEL=zai/glm-5.1:medium",
        "YF_STAGE_MODEL=deepseek/deepseek-v4-flash",
      ].join("\n"), "utf-8");
      writeFileSync(path.join(dir, "flow.yaml"), [
        'version: "1.0"',
        "defaults:",
        "  agent: agent.md",
        "  model: ${env.YF_DEFAULT_MODEL}",
        "stages:",
        "  - id: scan",
        "    skills: [test-skill]",
        "    model: ${env.YF_STAGE_MODEL}",
      ].join("\n"), "utf-8");
      const binDir = makeFakePi(dir, [
        "provider   model   context",
        "zai        glm-5.1  128K",
        "deepseek   deepseek-v4-flash  128K",
        "",
      ].join("\n"));
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;

      const parsed = parseFlow(path.join(dir, "flow.yaml"));
      const orch = new Orchestrator(parsed, {}, { outputDir: path.join(dir, "out") });

      expect(orch.model).toBe("zai/glm-5.1:medium");
      expect(orch.spec.stages[0].model).toBe("deepseek/deepseek-v4-flash");
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads pi internal retry settings from the flow .env", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "youngflow-env-pi-retry-"));
    try {
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n", "utf-8");
      writeFileSync(path.join(dir, ".env"), [
        "YOUNGFLOW_PI_RETRY_MAX_RETRIES=8",
        "YOUNGFLOW_PI_RETRY_BASE_DELAY_MS=5000",
      ].join("\n"), "utf-8");
      writeFileSync(path.join(dir, "flow.yaml"), [
        'version: "1.0"',
        "defaults:",
        "  agent: agent.md",
        "stages:",
        "  - id: scan",
      ].join("\n"), "utf-8");

      const parsed = parseFlow(path.join(dir, "flow.yaml"));
      new Orchestrator(parsed, {}, { outputDir: path.join(dir, "out"), skipModelPrecheck: true });

      expect(JSON.parse(readFileSync(path.join(dir, ".pi-agent", "settings.json"), "utf-8"))).toEqual({
        retry: { maxRetries: 8, baseDelayMs: 5000 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails before precheck when a stage model env var is missing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "youngflow-env-model-missing-"));
    try {
      mkdirSync(path.join(dir, "agents"), { recursive: true });
      mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
      writeFileSync(path.join(dir, "agents", "agent.md"), "agent\n", "utf-8");
      writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "skill\n", "utf-8");
      writeFileSync(path.join(dir, "flow.yaml"), [
        'version: "1.0"',
        "defaults:",
        "  agent: agent.md",
        "  model: zai/glm-5.1",
        "stages:",
        "  - id: scan",
        "    skills: [test-skill]",
        "    model: ${env.YF_STAGE_MODEL}",
      ].join("\n"), "utf-8");

      const parsed = parseFlow(path.join(dir, "flow.yaml"));
      expect(() => new Orchestrator(parsed, {}, { outputDir: path.join(dir, "out") }))
        .toThrow(/Missing env var YF_STAGE_MODEL for stages\[scan\]\.model/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
