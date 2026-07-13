import { describe, it, expect } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { precheckModels, resolveModelConfig, stripEffortSuffix, COMPACTION_EXTENSION_SOURCE } from "./model-config.js";

function tmpDir(name: string): string {
  return path.join(os.tmpdir(), `youngflow-model-config-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, "utf-8"));
}

function makeFakePi(dir: string, stdout: string, stderr = "", exitCode = 0): string {
  const binDir = path.join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const piPath = path.join(binDir, "pi");
  writeFileSync(piPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\nprocess.stderr.write(${JSON.stringify(stderr)});\nprocess.exit(${exitCode});\n`, "utf-8");
  chmodSync(piPath, 0o755);
  return binDir;
}

describe("resolveModelConfig", () => {
  it("copies provided models.json verbatim and passes env through", () => {
    const dir = tmpDir("copy");
    const prevGlobalAuth = process.env.PI_GLOBAL_AUTH_JSON;
    process.env.PI_GLOBAL_AUTH_JSON = path.join(dir, "no-such-auth.json");
    try {
      mkdirSync(dir, { recursive: true });
      const source = path.join(dir, "models.json");
      const content = '{\n  "providers": { "myprov": { "apiKey": "$MY_KEY", "models": [{ "id": "m1" }] } }\n}\n';
      writeFileSync(source, content, "utf-8");

      const config = resolveModelConfig({ MY_KEY: "secret", YOUNGFLOW_IDLE_TIMEOUT: "30" }, "myprov/m1:high", dir, undefined, source);

      expect(config.modelString).toBe("myprov/m1:high");
      expect(config.thinkingLevel).toBeUndefined();
      expect(config.agentDir).toBe(path.join(dir, ".pi-agent"));
      expect(config.envVars.MY_KEY).toBe("secret");
      expect(config.envVars.PI_CODING_AGENT_DIR).toBe(config.agentDir);
      expect(readFileSync(path.join(config.agentDir, "models.json"), "utf-8")).toBe(content);
      expect(readJson(path.join(config.agentDir, "auth.json"))).toEqual({});
    } finally {
      if (prevGlobalAuth === undefined) delete process.env.PI_GLOBAL_AUTH_JSON;
      else process.env.PI_GLOBAL_AUTH_JSON = prevGlobalAuth;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes empty models.json when absent for builtin providers", () => {
    const dir = tmpDir("empty");
    const prevGlobalAuth = process.env.PI_GLOBAL_AUTH_JSON;
    process.env.PI_GLOBAL_AUTH_JSON = path.join(dir, "no-such-auth.json");
    try {
      const config = resolveModelConfig({ ANTHROPIC_API_KEY: "secret" }, "anthropic/claude-sonnet-4-5", dir);
      expect(readJson(path.join(config.agentDir, "models.json"))).toEqual({ providers: {} });
      expect(readJson(path.join(config.agentDir, "settings.json"))).toEqual({});
      expect(readJson(path.join(config.agentDir, "auth.json"))).toEqual({});
    } finally {
      if (prevGlobalAuth === undefined) delete process.env.PI_GLOBAL_AUTH_JSON;
      else process.env.PI_GLOBAL_AUTH_JSON = prevGlobalAuth;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes pi internal retry settings from both env vars", () => {
    const dir = tmpDir("retry-both");
    try {
      const config = resolveModelConfig({
        YOUNGFLOW_PI_RETRY_MAX_RETRIES: "8",
        YOUNGFLOW_PI_RETRY_BASE_DELAY_MS: "5000",
      }, "anthropic/claude", dir);

      expect(readJson(path.join(config.agentDir, "settings.json"))).toEqual({
        retry: { maxRetries: 8, baseDelayMs: 5000 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows retry env vars independently and accepts zero retries", () => {
    const cases = [
      [{ YOUNGFLOW_PI_RETRY_MAX_RETRIES: "0" }, { retry: { maxRetries: 0 } }],
      [{ YOUNGFLOW_PI_RETRY_BASE_DELAY_MS: "2500" }, { retry: { baseDelayMs: 2500 } }],
    ] as const;

    for (const [env, expected] of cases) {
      const dir = tmpDir("retry-independent");
      try {
        const config = resolveModelConfig({ ...env }, "anthropic/claude", dir);
        expect(readJson(path.join(config.agentDir, "settings.json"))).toEqual(expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("rejects invalid pi internal retry env values", () => {
    for (const [name, value] of [
      ["YOUNGFLOW_PI_RETRY_MAX_RETRIES", "-1"],
      ["YOUNGFLOW_PI_RETRY_MAX_RETRIES", "1.5"],
      ["YOUNGFLOW_PI_RETRY_BASE_DELAY_MS", ""],
      ["YOUNGFLOW_PI_RETRY_BASE_DELAY_MS", "many"],
    ]) {
      const dir = tmpDir("retry-invalid");
      try {
        expect(() => resolveModelConfig({ [name]: value }, "anthropic/claude", dir)).toThrow(name);
        try {
          resolveModelConfig({ [name]: value }, "anthropic/claude", dir);
        } catch (error) {
          expect(String(error)).toContain(JSON.stringify(value));
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("merges pi internal retry settings with compaction settings", () => {
    const dir = tmpDir("retry-compaction");
    try {
      const config = resolveModelConfig({ YOUNGFLOW_PI_RETRY_MAX_RETRIES: "6" }, "anthropic/claude", dir, undefined, undefined, {
        enabled: true,
        reserveTokens: 40000,
        keepRecentTokens: 12000,
      });

      expect(readJson(path.join(config.agentDir, "settings.json"))).toEqual({
        compaction: { enabled: true, reserveTokens: 40000, keepRecentTokens: 12000 },
        retry: { maxRetries: 6 },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("inherits subscription auth from the global pi agent dir", () => {
    const dir = tmpDir("auth-inherit");
    const prevGlobalAuth = process.env.PI_GLOBAL_AUTH_JSON;
    try {
      mkdirSync(dir, { recursive: true });
      const globalAuth = path.join(dir, "global-auth.json");
      const authContent = { "openai-codex": { type: "oauth", access: "tok" } };
      writeFileSync(globalAuth, JSON.stringify(authContent), "utf-8");
      process.env.PI_GLOBAL_AUTH_JSON = globalAuth;

      const config = resolveModelConfig({}, "openai-codex/gpt-5.5:high", dir);
      expect(readJson(path.join(config.agentDir, "auth.json"))).toEqual(authContent);
    } finally {
      if (prevGlobalAuth === undefined) delete process.env.PI_GLOBAL_AUTH_JSON;
      else process.env.PI_GLOBAL_AUTH_JSON = prevGlobalAuth;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to empty auth when global auth is corrupt", () => {
    const dir = tmpDir("auth-corrupt");
    const prevGlobalAuth = process.env.PI_GLOBAL_AUTH_JSON;
    try {
      mkdirSync(dir, { recursive: true });
      const globalAuth = path.join(dir, "global-auth.json");
      writeFileSync(globalAuth, "{ not valid json", "utf-8");
      process.env.PI_GLOBAL_AUTH_JSON = globalAuth;

      const config = resolveModelConfig({}, "anthropic/claude-sonnet-4-5", dir);
      expect(readJson(path.join(config.agentDir, "auth.json"))).toEqual({});
    } finally {
      if (prevGlobalAuth === undefined) delete process.env.PI_GLOBAL_AUTH_JSON;
      else process.env.PI_GLOBAL_AUTH_JSON = prevGlobalAuth;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes pi compaction settings and materializes import-free bundled extension", () => {
    const dir = tmpDir("compaction");
    try {
      const config = resolveModelConfig({}, "anthropic/claude", dir, undefined, undefined, {
        enabled: true,
        reserveTokens: 40000,
        keepRecentTokens: 12000,
      });

      expect(readJson(path.join(config.agentDir, "settings.json"))).toEqual({
        compaction: {
          enabled: true,
          reserveTokens: 40000,
          keepRecentTokens: 12000,
        },
      });
      expect(config.compactionExtensionPath).toBe(path.join(config.agentDir, "yf-compaction.ts"));
      const extSource = readFileSync(config.compactionExtensionPath, "utf-8");
      expect(extSource).toContain("export default function youngflowCompactionExtension");
      expect(extSource).not.toMatch(/^import\s/m);
      expect(extSource).not.toMatch(/:\s*any\b|\):\s*void\b/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs bundled compaction extension only when usage crosses threshold", () => {
    // Execute the emitted source string itself (what pi actually loads), not a
    // separate TS function — this guarantees no drift between tested logic and shipped extension.
    const factory = new Function(`return (${COMPACTION_EXTENSION_SOURCE.replace(/^export default /, "")})`);
    const extension = factory() as (pi: any) => void;
    const prev = process.env.YOUNGFLOW_COMPACT_AT;
    try {
      process.env.YOUNGFLOW_COMPACT_AT = "0.7";
      let handler: ((event: any, ctx: any) => void) | undefined;
      const pi = { on: (_event: string, cb: any) => { handler = cb; } };
      extension(pi);

      let compactCalls = 0;
      const ctx = {
        getContextUsage: () => ({ tokens: 700, contextWindow: 1000 }),
        compact: (_opts: any) => { compactCalls++; },
      };
      handler?.({}, { ...ctx, getContextUsage: () => ({ tokens: 699, contextWindow: 1000 }) });
      expect(compactCalls).toBe(0);
      handler?.({}, { ...ctx, getContextUsage: () => ({ tokens: null, contextWindow: 1000 }) });
      expect(compactCalls).toBe(0);
      handler?.({}, ctx);
      expect(compactCalls).toBe(1);
      handler?.({}, ctx);
      expect(compactCalls).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.YOUNGFLOW_COMPACT_AT;
      else process.env.YOUNGFLOW_COMPACT_AT = prev;
    }
  });

  it("writes settings.json and agents symlink", () => {
    const dir = tmpDir("agents");
    try {
      const agentsDir = path.join(dir, "agents-src");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(path.join(agentsDir, "default.md"), "agent", "utf-8");
      const config = resolveModelConfig({}, "anthropic/claude", dir, agentsDir);
      expect(existsSync(path.join(config.agentDir, "settings.json"))).toBe(true);
      const link = path.join(config.agentDir, "agents");
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("precheckModels", () => {
  it("passes when referenced models are listed and strips effort suffix", () => {
    const dir = tmpDir("precheck-pass");
    try {
      mkdirSync(dir, { recursive: true });
      const binDir = makeFakePi(dir, "provider   model   context\nanthropic  claude-sonnet-4-5  200K\nmyprov     m1  128K\n");
      expect(() => precheckModels(["anthropic/claude-sonnet-4-5:high", "myprov/m1"], dir, { PATH: `${binDir}:${process.env.PATH ?? ""}` })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes when pi writes the model table to stderr", () => {
    const dir = tmpDir("precheck-stderr");
    try {
      mkdirSync(dir, { recursive: true });
      const binDir = makeFakePi(dir, "", "provider   model   context\nzai        glm-5.1  128K\n");
      expect(() => precheckModels(["zai/glm-5.1:medium"], dir, { PATH: `${binDir}:${process.env.PATH ?? ""}` })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when a referenced model is absent", () => {
    const dir = tmpDir("precheck-missing");
    try {
      mkdirSync(dir, { recursive: true });
      const binDir = makeFakePi(dir, "provider   model   context\nanthropic  claude-sonnet-4-5  200K\n");
      expect(() => precheckModels(["myprov/missing"], dir, { PATH: `${binDir}:${process.env.PATH ?? ""}` })).toThrow(/Model\(s\) unavailable: myprov\/missing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces pi models.json load errors", () => {
    const dir = tmpDir("precheck-invalid");
    try {
      mkdirSync(dir, { recursive: true });
      const binDir = makeFakePi(dir, "", "Warning: errors loading models.json:\nInvalid models.json schema:\n  - providers.x.baseUrl: must be string\n");
      expect(() => precheckModels(["x/m"], dir, { PATH: `${binDir}:${process.env.PATH ?? ""}` })).toThrow(/Invalid models\.json:[\s\S]*baseUrl: must be string/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not leak key values in missing-model errors", () => {
    const dir = tmpDir("precheck-secret");
    try {
      mkdirSync(dir, { recursive: true });
      const binDir = makeFakePi(dir, "provider   model   context\n");
      expect(() => precheckModels(["myprov/m1"], dir, { PATH: `${binDir}:${process.env.PATH ?? ""}`, MY_KEY: "sk-secret-value" })).toThrow(/Model\(s\) unavailable/);
      try {
        precheckModels(["myprov/m1"], dir, { PATH: `${binDir}:${process.env.PATH ?? ""}`, MY_KEY: "sk-secret-value" });
      } catch (err: any) {
        expect(err.message).not.toContain("sk-secret-value");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stripEffortSuffix", () => {
  it("strips known effort suffixes only", () => {
    expect(stripEffortSuffix("anthropic/claude:high")).toBe("anthropic/claude");
    expect(stripEffortSuffix("myprov/model:custom")).toBe("myprov/model:custom");
  });
});
