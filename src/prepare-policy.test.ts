import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseFlow } from "./spec.js";
import {
  Runner,
  assertRestrictedPrepareCommand,
  buildRestrictedPrepareEnv,
  formatRestrictedToolArgsSummary,
  formatRestrictedToolCallDisplay,
} from "./runner.js";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function runner(root: string) {
  const prompt = path.join(root, "agent.md"); writeFileSync(prompt, "safe");
  return new Runner({
    modelConfig: { modelString: "anthropic/test", thinkingLevel: undefined, agentDir: path.join(root, "agent"), envVars: {} },
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
    const env = buildRestrictedPrepareEnv(processEnv, {}, { YOUNGFLOW_STAGE_ID: "prepare" }, "anthropic/test");
    expect(env.ANTHROPIC_API_KEY).toBe("selected-secret");
    for (const key of ["OPENAI_API_KEY", "DATABASE_URL", "MINIO_SECRET_KEY", "SANDBOX_TOKEN", "SSH_AUTH_SOCK", "DOCKER_HOST", "ISSUER_TOKEN", "NODE_OPTIONS"]) expect(env).not.toHaveProperty(key);
    expect(env).toMatchObject({ PI_OFFLINE: "1", HOME: path.join(root, "control/home"), TMPDIR: path.join(root, "control/tmp") });
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
    const argsFile = path.join(root, "args.txt"), envFile = path.join(root, "env.txt"), cwdFile = path.join(root, "cwd.txt");
    const pi = path.join(bin, "pi");
    writeFileSync(pi, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nenv | sort > '${envFile}'\npwd > '${cwdFile}'\nprintf '%s\\n' '{"type":"turn_start"}' '{"type":"message_end","message":{"content":[{"type":"text","text":"done"}],"usage":{"input":1,"output":1,"totalTokens":2},"stopReason":"stop"}}'\n`);
    chmodSync(pi, 0o755);
    const control = path.join(root, "control"), output = path.join(root, "durable"), runtime = path.join(control, "runtime");
    mkdirSync(runtime, { recursive: true }); mkdirSync(output);
    const r = runner(root);
    const result = await r.run({
      skillDirs: [path.join(root, "skill")], task: "trusted", inputFiles: [], timeout: 10,
      extensions: [path.join(root, "extension")], envExtra: {
        PATH: `${bin}:/usr/bin`, PREPARE_CONTROL_DIR: control, PREPARE_PI_HOME: path.join(control, "pi"),
        PREPARE_SOURCE_ROOT: path.join(root, "source"), PREPARE_OUTPUT_DIR: output,
        PREPARE_PLANNER_INPUT: path.join(control, "input"), PREPARE_MANIFEST_SCHEMA: path.join(root, "manifest"),
        PREPARE_PLAN_SCHEMA: path.join(root, "plan"), DATABASE_URL: "must-not-pass", OPENAI_API_KEY: "extra-provider",
      }, stageId: "prepare", tools: ["read_project_manifest", "read_project_file", "submit_plan"],
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

  it("preflight rejects extra extension/skill, builtin tools and session persistence", () => {
    const base = ["pi", "-p", "--mode", "json", "--no-skills", "--skill", "safe", "--no-extensions", "-e", "safe", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve", "--offline", "--no-session", "--tools", "read_project_manifest,read_project_file,submit_plan", "task"];
    expect(() => assertRestrictedPrepareCommand(base)).not.toThrow();
    expect(() => assertRestrictedPrepareCommand([...base, "-e", "evil"])).toThrow();
    const builtin = [...base]; builtin[builtin.indexOf("--tools") + 1] += ",bash";
    expect(() => assertRestrictedPrepareCommand(builtin)).toThrow();
    expect(() => assertRestrictedPrepareCommand([...base, "--session", "leak.jsonl"])).toThrow();
  });
});
