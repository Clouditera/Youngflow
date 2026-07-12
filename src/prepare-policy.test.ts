import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlow } from "./spec.js";
import { precheckModels } from "./model-config.js";
import { assertRestrictedPrepareDirectories } from "./orchestrator.js";
import {
  Runner,
  assertRestrictedPrepareCommand,
  buildRestrictedPrepareEnv,
  buildRestrictedPostflightEnv,
  formatRestrictedToolArgsSummary,
  formatRestrictedToolCallDisplay,
  exceedsRestrictedPrepareToolBudget,
} from "./runner.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function parentFixture(root: string, plan: any = validPlan()) {
  const repo = path.resolve(import.meta.dirname, "../../..");
  const source = path.join(root, "source"), control = path.join(root, "control"), output = path.join(root, "output");
  mkdirSync(source); mkdirSync(control); mkdirSync(output);
  const manifest = {
    schema_version: "source-manifest/v1",
    source: { kind: "directory", projection_sha256: "a".repeat(64), identity_scope: "bounded_manifest_projection" },
    root_candidates: [{ path: ".", marker_paths: [] }],
    tree: [{ path: ".", type: "directory", size: 0, sha256: null, extension: null }],
    statistics: { files_observed: 0, directories_observed: 1, bytes_observed: 0, bytes_hashed: 0, excluded_sensitive_entries: 0, excluded_vcs_entries: 0, extensions: [], languages: [] },
    markers: [], signals: [],
    limits: { maxEntries: 100, maxFiles: 100, maxTotalHashBytes: 1024, maxSingleFileHashBytes: 1024, maxDepth: 8, maxIndexedMarkers: 100 },
    truncation: { truncated: true, reasons: ["max_entries"] }, warnings: [],
  };
  const input = {
    schema_version: "prepare-planner-input/v1", source_manifest: manifest,
    task_flags: { enable_poc: false, enable_exp: false, requested_stages: ["static_audit"] },
    capability_catalog: { version: "v1", capabilities: ["ssh", "shell", "compiler", "docker", "qemu_system"] },
    profile_recommendation_mode: "requirements_only",
  };
  const plannerInput = path.join(control, "planner-input.json"); writeFileSync(plannerInput, JSON.stringify(input), { mode: 0o600 });
  const serialized = JSON.stringify(plan, null, 2) + "\n";
  writeFileSync(path.join(output, "assessment-plan.json"), serialized, { mode: 0o600 }); chmodSync(path.join(output, "assessment-plan.json"), 0o600);
  const counters = { totalCalls: 1, manifestCalls: 0, fileCalls: 0, submitCalls: 1, manifestBytes: 0, fileBytes: 0, diskBytes: 0, distinctFiles: 0 };
  writeFileSync(path.join(control, "receipt.json"), canonical({ status: "committed", schema_version: "prepare-receipt/v2", decision_sha256: "d".repeat(64), plan_sha256: createHash("sha256").update(serialized).digest("hex"), manifest_sha256: createHash("sha256").update(canonical(manifest)).digest("hex"), counters }) + "\n", { mode: 0o600 });
  return {
    source, control, output,
    extension: path.join(repo, "flows/prepare/extensions/prepare-tools"),
    env: {
      PREPARE_CONTROL_DIR: control, PREPARE_PI_HOME: path.join(control, "pi"), PREPARE_SOURCE_ROOT: source,
      PREPARE_OUTPUT_DIR: output, PREPARE_PLANNER_INPUT: plannerInput,
      PREPARE_MANIFEST_SCHEMA: path.join(repo, "packages/service/src/features/prepare/schemas/source-manifest-v1.schema.json"),
      PREPARE_PLAN_SCHEMA: path.join(repo, "flows/prepare/schemas/prepare-assessment-plan-v1.schema.yaml"),
    },
  };
}

function validPlan() {
  return {
    schema_version: "1.0",
    source_assessment: {
      status: "incomplete", submission_shape: "project", intended_project: "Example project", root_candidates: ["."],
      missing_components: [{ category: "build_manifest", name: "Build definition", expected_by: "No build definition is present.", evidence_paths: ["."], impact: ["static_audit"], recoverable_from_submission: false }],
      external_dependencies: [], uncertainties: [],
      stage_readiness: { static_audit: { status: "limited", reasons: ["Build definition is absent."] }, build: { status: "not_requested", reasons: [] }, poc: { status: "not_requested", reasons: [] }, exp: { status: "not_requested", reasons: [] } },
      confidence: 0.9, summary: "The submitted project lacks a build definition.",
      evidence: [{ path: ".", signal: "other", observation: "The trusted manifest is materially truncated." }],
      user_recommendations: [{ code: "include_build_files", message: "Include the project build definition." }],
    }, sandbox_plan: null, warnings: [],
  };
}

function runner(root: string) {
  const prompt = path.join(root, "agent.md"); writeFileSync(prompt, "safe");
  return new Runner({
    modelConfig: { modelString: "anthropic/test", thinkingLevel: undefined, agentDir: path.join(root, "control/.pi-agent"), compactionExtensionPath: path.join(root, "control/.pi-agent/yf-compaction.ts"), envVars: { PI_CODING_AGENT_DIR: path.join(root, "control/.pi-agent") } },
    engineConfig: { errorRetries: 9, errorRetryBackoff: 1, idleTimeout: 300, exportSessions: true },
    systemPromptPath: prompt,
    sessionDir: path.join(root, "sessions"),
  });
}

describe("prepare-restricted execution policy", () => {
  it("F01/F02 parses one stage and builds exact no-context/no-session/offline argv", () => {
    const repo = path.resolve(import.meta.dirname, "../../..");
    const spec = parseFlow(path.join(repo, "flows/prepare/flow.prepare.yaml"));
    expect(spec.stages).toHaveLength(1);
    expect(spec.stages[0]).toMatchObject({ type: "single", executionPolicy: "prepare-restricted", timeout: 600, errorStrategy: "stop" });
    expect(spec.defaultMaxParallel).toBe(1);
    expect(spec.defaultTools).toEqual(["read_project_manifest", "read_project_file", "submit_plan"]);

    const root = mkdtempSync(path.join(tmpdir(), "prepare-runner-")); roots.push(root);
    const r = runner(root);
    const command = (r as any).buildCommand({
      skillDirs: [path.join(repo, "flows/prepare/skills/prepare-tool-protocol")], task: "trusted task",
      inputFiles: [], timeout: 600, extensions: [path.join(repo, "flows/prepare/extensions/prepare-tools")],
      envExtra: {}, stageId: "prepare", tools: [...spec.defaultTools!], workDir: path.join(root, "runtime"),
      executionPolicy: "prepare-restricted",
    });
    expect(() => assertRestrictedPrepareCommand(command)).not.toThrow();
    expect(command).toEqual(expect.arrayContaining(["--no-context-files", "--no-approve", "--offline", "--no-session"]));
    expect(command).not.toContain("--session-dir");
    expect(command.filter((arg) => arg === "-e")).toHaveLength(1);
    expect(command.join(" ")).not.toContain("yf-compaction");
    expect(command.join(" ")).not.toMatch(/\bread,bash|\bedit\b|\bwrite\b|\bsubagent\b/);
  });

  it("F04/F05 constructs provider-minimal env and strips platform/extra-provider canaries", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-env-")); roots.push(root);
    const processEnv = {
      PATH: "/usr/bin", LANG: "C.UTF-8", PREPARE_CONTROL_DIR: path.join(root, "control"),
      PREPARE_PI_HOME: path.join(root, "control/pi"), PREPARE_SOURCE_ROOT: path.join(root, "source"),
      PREPARE_OUTPUT_DIR: path.join(root, "output"), PREPARE_PLANNER_INPUT: path.join(root, "input.json"),
      PREPARE_MANIFEST_SCHEMA: path.join(root, "manifest.json"), PREPARE_PLAN_SCHEMA: path.join(root, "plan.yaml"),
      ANTHROPIC_API_KEY: "selected-secret", OPENAI_API_KEY: "extra-secret", DATABASE_URL: "db-secret",
      MINIO_SECRET_KEY: "minio-secret", SANDBOX_TOKEN: "sandbox-secret", SSH_AUTH_SOCK: "/secret/socket",
      DOCKER_HOST: "unix:///secret", ISSUER_TOKEN: "issuer-secret", NODE_OPTIONS: "--require evil",
    };
    const env = buildRestrictedPrepareEnv(processEnv, { PI_CODING_AGENT_DIR: path.join(root, "control/.pi-agent") }, { YOUNGFLOW_STAGE_ID: "prepare" }, "anthropic/test");
    expect(env.ANTHROPIC_API_KEY).toBe("selected-secret");
    for (const key of ["OPENAI_API_KEY", "DATABASE_URL", "MINIO_SECRET_KEY", "SANDBOX_TOKEN", "SSH_AUTH_SOCK", "DOCKER_HOST", "ISSUER_TOKEN", "NODE_OPTIONS"]) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ PI_OFFLINE: "1", HOME: path.join(root, "control/home"), TMPDIR: path.join(root, "control/tmp"), PI_CODING_AGENT_DIR: path.join(root, "control/.pi-agent"), PREPARE_PI_HOME: path.join(root, "control/.pi-agent") });
    const postflightEnv = buildRestrictedPostflightEnv({ ...env, HTTPS_PROXY: "proxy-canary", ANTHROPIC_API_KEY: "provider-canary" });
    expect(postflightEnv).not.toHaveProperty("HTTPS_PROXY");
    expect(postflightEnv).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  it("F04 restricted model precheck replaces process env and redacts failures", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-precheck-")); roots.push(root);
    const bin = path.join(root, "bin"); mkdirSync(bin);
    const envFile = path.join(root, "env.txt");
    const pi = path.join(bin, "pi");
    writeFileSync(pi, `#!/bin/sh\nenv | sort > '${envFile}'\nprintf 'anthropic test\\n'\n`); chmodSync(pi, 0o755);
    const keys = ["DATABASE_URL", "MINIO_SECRET_KEY", "NODE_OPTIONS"] as const;
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.DATABASE_URL = "db-canary";
    process.env.MINIO_SECRET_KEY = "minio-canary";
    process.env.NODE_OPTIONS = "--canary";
    try {
      precheckModels(["anthropic/test"], path.join(root, "agent"), { PATH: `${bin}:/usr/bin`, HOME: root }, { replaceEnv: true, redactErrors: true });
    } finally {
      for (const key of keys) previous[key] === undefined ? delete process.env[key] : process.env[key] = previous[key];
    }
    const childEnv = readFileSync(envFile, "utf8");
    expect(childEnv).not.toMatch(/DATABASE_URL|MINIO_SECRET_KEY|NODE_OPTIONS/);
  });

  it("F03 rejects overlapping directories and workspace outside control", () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-dirs-")); roots.push(root);
    const source = path.join(root, "source"), control = path.join(root, "control"), output = path.join(root, "output");
    mkdirSync(source); mkdirSync(control); mkdirSync(output);
    const previous = { source: process.env.PREPARE_SOURCE_ROOT, control: process.env.PREPARE_CONTROL_DIR, output: process.env.PREPARE_OUTPUT_DIR };
    process.env.PREPARE_SOURCE_ROOT = source; process.env.PREPARE_CONTROL_DIR = control; process.env.PREPARE_OUTPUT_DIR = path.join(control, "nested");
    mkdirSync(process.env.PREPARE_OUTPUT_DIR);
    expect(() => assertRestrictedPrepareDirectories(control, control)).toThrow(/disjoint/);
    process.env.PREPARE_OUTPUT_DIR = output;
    expect(() => assertRestrictedPrepareDirectories(source, control)).toThrow(/workspace/);
    previous.source === undefined ? delete process.env.PREPARE_SOURCE_ROOT : process.env.PREPARE_SOURCE_ROOT = previous.source;
    previous.control === undefined ? delete process.env.PREPARE_CONTROL_DIR : process.env.PREPARE_CONTROL_DIR = previous.control;
    previous.output === undefined ? delete process.env.PREPARE_OUTPUT_DIR : process.env.PREPARE_OUTPUT_DIR = previous.output;
  });

  it("F06 redacts submit args in global and stage displays", () => {
    const args = { plan: { source_assessment: { summary: "raw-plan-must-not-log" } } };
    for (const rendered of [formatRestrictedToolArgsSummary("submit_plan", args), formatRestrictedToolCallDisplay("submit_plan", args)]) {
      expect(rendered).toContain("plan=<redacted>");
      expect(rendered).not.toContain("raw-plan-must-not-log");
    }
  });

  it("F02/F03/F04 runs a fake pi with exact argv, private cwd and sanitized env", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-actual-")); roots.push(root);
    const bin = path.join(root, "bin"); mkdirSync(bin);
    const argsFile = path.join(root, "args.txt"), envFile = path.join(root, "env.txt"), precheckEnvFile = path.join(root, "precheck-env.txt"), cwdFile = path.join(root, "cwd.txt");
    const pi = path.join(bin, "pi");
    writeFileSync(pi, `#!/bin/sh\nif [ "\${1:-}" = "--list-models" ]; then env | sort > '${precheckEnvFile}'; printf 'anthropic test\\n'; exit 0; fi\nprintf '%s\\n' "$@" > '${argsFile}'\nenv | sort > '${envFile}'\npwd > '${cwdFile}'\nprintf '%s\\n' '{"type":"turn_start"}' '{"type":"message_end","message":{"content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2},"stopReason":"stop"}}'\n`);
    chmodSync(pi, 0o755);
    const control = path.join(root, "control"), output = path.join(root, "durable"), runtime = path.join(control, "runtime");
    mkdirSync(runtime, { recursive: true }); mkdirSync(output);
    const r = runner(root);
    const baseEnv = {
      PATH: `${bin}:/usr/bin`, PREPARE_CONTROL_DIR: control, PREPARE_PI_HOME: path.join(control, "pi"),
      PREPARE_SOURCE_ROOT: path.join(root, "source"), PREPARE_OUTPUT_DIR: output,
      PREPARE_PLANNER_INPUT: path.join(control, "input"), PREPARE_MANIFEST_SCHEMA: path.join(root, "manifest"),
      PREPARE_PLAN_SCHEMA: path.join(root, "plan"), DATABASE_URL: "must-not-pass", OPENAI_API_KEY: "extra-provider",
    };
    const precheckEnv = buildRestrictedPrepareEnv(baseEnv, r.modelConfig.envVars, {}, r.modelConfig.modelString);
    precheckModels(["anthropic/test"], r.modelConfig.agentDir, precheckEnv, { replaceEnv: true, redactErrors: true });
    const result = await r.run({
      skillDirs: [path.join(root, "skill")], task: "trusted", inputFiles: [], timeout: 10,
      extensions: [path.join(root, "extension")], envExtra: baseEnv,
      stageId: "prepare", tools: ["read_project_manifest", "read_project_file", "submit_plan"],
      workDir: runtime, executionPolicy: "prepare-restricted",
    });
    // Fake pi does not submit a validated plan/receipt, so postflight must fail
    // even though argv/env capture and the process itself succeeded.
    expect(result.exitCode).toBe(3);
    expect(readFileSync(argsFile, "utf8")).toContain("--no-session\n");
    expect(readFileSync(argsFile, "utf8")).toContain("read_project_manifest,read_project_file,submit_plan");
    expect(readFileSync(cwdFile, "utf8").trim()).toBe(runtime);
    const childEnv = readFileSync(envFile, "utf8");
    expect(childEnv).not.toContain("DATABASE_URL=");
    expect(childEnv).not.toContain("OPENAI_API_KEY=");
    const precheckChildEnv = readFileSync(precheckEnvFile, "utf8");
    const piHome = childEnv.split("\n").find((line) => line.startsWith("PI_CODING_AGENT_DIR="));
    expect(precheckChildEnv.split("\n")).toContain(piHome);
    expect(piHome).toBe(`PI_CODING_AGENT_DIR=${path.join(control, ".pi-agent")}`);
  });

  it("enforces parent-observed manifest/file/submit start budgets and stops the process group", async () => {
    const execute = async (toolName: string, starts: number) => {
      const root = mkdtempSync(path.join(tmpdir(), "prepare-tool-budget-")); roots.push(root);
      const bin = path.join(root, "bin"), control = path.join(root, "control"), output = path.join(root, "output");
      mkdirSync(bin); mkdirSync(control); mkdirSync(output); writeFileSync(path.join(output, "must-remove"), "x");
      const pi = path.join(bin, "pi");
      const lines = Array.from({ length: starts }, () => JSON.stringify({ type: "tool_execution_start", toolName, args: { malformed: true } })).join("\\n");
      writeFileSync(pi, `#!/bin/sh\nprintf '%b\\n' '${lines}\\n'\nsleep 30\n`); chmodSync(pi, 0o755);
      const started = Date.now();
      const result = await runner(root).run({
        skillDirs: ["skill"], task: "trusted", inputFiles: [], timeout: 20, extensions: ["extension"],
        envExtra: { PATH: `${bin}:/usr/bin`, PREPARE_CONTROL_DIR: control, PREPARE_PI_HOME: path.join(control, "pi"), PREPARE_OUTPUT_DIR: output },
        stageId: "prepare", tools: ["read_project_manifest", "read_project_file", "submit_plan"], workDir: control, executionPolicy: "prepare-restricted",
      });
      expect(result).toMatchObject({ exitCode: 3, lastError: "prepare tool budget exceeded", retries: 0 });
      expect(result.toolCalls).toHaveLength(starts);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(readdirSync(output)).toEqual([]); expect(readdirSync(control)).toEqual([]);
    };
    await execute("read_project_manifest", 13);
    await execute("read_project_file", 33);
    await execute("submit_plan", 4);
  }, 20_000);

  it("keeps the total-start guard as a future-facing pure defense without weakening category limits", () => {
    expect(exceedsRestrictedPrepareToolBudget({ total: 48, manifest: 12, file: 32, submit: 3 })).toBe(false);
    expect(exceedsRestrictedPrepareToolBudget({ total: 49, manifest: 0, file: 0, submit: 0 })).toBe(true);
    expect(exceedsRestrictedPrepareToolBudget({ total: 13, manifest: 13, file: 0, submit: 0 })).toBe(true);
    expect(exceedsRestrictedPrepareToolBudget({ total: 33, manifest: 0, file: 33, submit: 0 })).toBe(true);
    expect(exceedsRestrictedPrepareToolBudget({ total: 4, manifest: 0, file: 0, submit: 4 })).toBe(true);
  });

  it("F07 enforces token budget and outer retry=0, removing a durable plan", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-budget-")); roots.push(root);
    const bin = path.join(root, "bin"); mkdirSync(bin); const count = path.join(root, "count");
    const pi = path.join(bin, "pi");
    writeFileSync(pi, `#!/bin/sh\necho x >> '${count}'\nprintf '%s\\n' '{"type":"message_end","message":{"content":[{"type":"text","text":"x"}],"usage":{"input":1,"output":24001,"totalTokens":24002},"stopReason":"stop"}}'\nexit 1\n`); chmodSync(pi, 0o755);
    const control = path.join(root, "control"), output = path.join(root, "output"); mkdirSync(control); mkdirSync(output);
    writeFileSync(path.join(output, "assessment-plan.json"), "must be removed");
    const result = await runner(root).run({
      skillDirs: ["skill"], task: "trusted", inputFiles: [], timeout: 10, extensions: ["extension"],
      envExtra: { PATH: `${bin}:/usr/bin`, PREPARE_CONTROL_DIR: control, PREPARE_PI_HOME: path.join(control, "pi"), PREPARE_OUTPUT_DIR: output },
      stageId: "prepare", tools: ["read_project_manifest", "read_project_file", "submit_plan"], workDir: control,
      executionPolicy: "prepare-restricted",
    });
    expect(result.exitCode).toBe(3);
    expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(1);
    expect(() => readFileSync(path.join(output, "assessment-plan.json"))).toThrow();
  });

  it("S/R parent independently rejects forged plans and cleans nonzero/abort outputs", async () => {
    const execute = async (plan: any, exitCode = 0, abort = false, receiptMode = 0o600) => {
      const root = mkdtempSync(path.join(tmpdir(), "prepare-parent-")); roots.push(root);
      const f = parentFixture(root, plan);
      chmodSync(path.join(f.control, "receipt.json"), receiptMode);
      const bin = path.join(root, "bin"); mkdirSync(bin);
      const pi = path.join(bin, "pi");
      writeFileSync(pi, `#!/bin/sh\nprintf '%s\\n' '{"type":"tool_execution_start","toolName":"submit_plan","args":{"plan":"redacted"}}' '{"type":"tool_execution_end","toolName":"submit_plan","isError":false,"result":"ok"}' '{"type":"message_end","message":{"content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2},"stopReason":"stop"}}'\n${abort ? "sleep 5" : ""}\nexit ${exitCode}\n`); chmodSync(pi, 0o755);
      const controller = new AbortController();
      if (abort) setTimeout(() => controller.abort(), 50);
      const result = await runner(root).run({
        skillDirs: [path.join(root, "skill")], task: "trusted", inputFiles: [], timeout: 10,
        extensions: [f.extension], envExtra: { PATH: `${bin}:/usr/bin`, ...f.env }, stageId: "prepare",
        tools: ["read_project_manifest", "read_project_file", "submit_plan"], workDir: f.control,
        executionPolicy: "prepare-restricted", abortSignal: controller.signal,
      });
      return { ...f, result };
    };

    const valid = await execute(validPlan());
    expect(valid.result.exitCode).toBe(0);
    expect(readdirSync(valid.output)).toEqual(["assessment-plan.json"]);
    expect(() => readFileSync(path.join(valid.control, "receipt.json"))).toThrow();

    const forged = await execute({});
    expect(forged.result.exitCode).toBe(3);
    expect(readdirSync(forged.output)).toEqual([]);

    const publicReceipt = await execute(validPlan(), 0, false, 0o644);
    expect(publicReceipt.result.exitCode).toBe(3);
    expect(readdirSync(publicReceipt.output)).toEqual([]);

    const nonzero = await execute(validPlan(), 1);
    expect(nonzero.result.exitCode).toBe(3);
    expect(readdirSync(nonzero.output)).toEqual([]);

    const killed = await execute(validPlan(), 0, true);
    expect(killed.result.exitCode).toBe(3);
    expect(readdirSync(killed.output)).toEqual([]);
  }, 20_000);

  it("keeps non-restricted timeout termination graceful", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "prepare-main-term-")); roots.push(root);
    const bin = path.join(root, "bin"); mkdirSync(bin);
    const marker = path.join(root, "term.txt"), pi = path.join(bin, "pi");
    writeFileSync(pi, `#!/bin/sh\ntrap 'echo TERM > "${marker}"; exit 0' TERM\nwhile :; do sleep 1; done\n`); chmodSync(pi, 0o755);
    const r = runner(root); (r.engineConfig as any).errorRetries = 0;
    await r.run({ skillDirs: [], task: "normal", inputFiles: [], timeout: 0.05, extensions: [], envExtra: { PATH: `${bin}:/usr/bin` }, stageId: "normal", workDir: root });
    expect(readFileSync(marker, "utf8").trim()).toBe("TERM");
  });

  it("preflight rejects extra extension/skill, builtin tools and session persistence", () => {
    const base = ["pi", "-p", "--mode", "json", "--no-skills", "--skill", "safe", "--no-extensions", "-e", "safe", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--no-session", "--tools", "read_project_manifest,read_project_file,submit_plan", "task"];
    expect(() => assertRestrictedPrepareCommand(base)).not.toThrow();
    expect(() => assertRestrictedPrepareCommand([...base, "-e", "evil"])).toThrow();
    const builtin = [...base]; builtin[builtin.indexOf("--tools") + 1] += ",bash";
    expect(() => assertRestrictedPrepareCommand(builtin)).toThrow();
    expect(() => assertRestrictedPrepareCommand([...base, "--session", "leak.jsonl"])).toThrow();
  });
});
