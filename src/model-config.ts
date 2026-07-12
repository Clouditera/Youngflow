/**
 * Model configuration: prepare pi agent dir for direct models.json usage.
 *
 * YoungFlow no longer translates LLM_* env vars into pi config. Users either rely
 * on pi builtin providers with standard key env vars, or provide a pi-native
 * models.json via artifacts.models_json.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { debug } from "./logger.js";

export interface ModelConfig {
  readonly modelString: string;
  readonly thinkingLevel: string | undefined;
  readonly agentDir: string;
  readonly envVars: Record<string, string>;
}

export function resolveModelConfig(
  env: Record<string, string>,
  defaultModel: string,
  agentDirBase?: string,
  agentsDir?: string,
  modelsJsonPath?: string,
  inheritGlobalAuth = true,
): ModelConfig {
  const agentDir = createAgentDir({
    base: agentDirBase,
    agentsDir,
    modelsJsonPath,
    inheritGlobalAuth,
  });

  if (inheritGlobalAuth === false) {
    debug("model_config", "info", "Restricted model config initialized");
  } else {
    debug(
      "model_config",
      "info",
      "Model config: model=%s agentDir=%s modelsJson=%s",
      defaultModel,
      agentDir,
      modelsJsonPath ?? "(empty)",
    );
  }

  return {
    modelString: defaultModel,
    thinkingLevel: undefined,
    agentDir,
    envVars: {
      ...env,
      PI_CODING_AGENT_DIR: agentDir,
    },
  };
}

function createAgentDir(opts: {
  base?: string;
  agentsDir?: string;
  modelsJsonPath?: string;
  inheritGlobalAuth?: boolean;
}): string {
  const agentDir = path.join(opts.base ?? process.cwd(), ".pi-agent");
  mkdirSync(agentDir, { recursive: true, mode: opts.inheritGlobalAuth === false ? 0o700 : undefined });

  // Inherit subscription credentials (OAuth: ChatGPT/Codex, Claude Pro/Max,
  // Copilot) from the user's global pi agent dir. Pi stores these in
  // ~/.pi/agent/auth.json and they cannot be supplied via models.json env keys.
  // Without this, only env-key providers work; builtin subscription models
  // (e.g. openai-codex/gpt-5.5) fail the precheck. Empty/missing global auth
  // yields {} — identical to the previous behavior.
  writeFileSync(path.join(agentDir, "auth.json"), opts.inheritGlobalAuth === false ? "{}" : readGlobalAuth(), { encoding: "utf-8", mode: 0o600 });

  if (opts.modelsJsonPath) {
    copyFileSync(opts.modelsJsonPath, path.join(agentDir, "models.json"));
  } else {
    writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: {} }, null, 2) + "\n",
      "utf-8",
    );
  }

  const settingsPath = path.join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, "{}", "utf-8");
  }

  if (opts.inheritGlobalAuth === false) {
    chmodSync(agentDir, 0o700);
    chmodSync(path.join(agentDir, "auth.json"), 0o600);
    chmodSync(path.join(agentDir, "models.json"), 0o600);
    chmodSync(settingsPath, 0o600);
  }

  if (opts.agentsDir && existsSync(opts.agentsDir) && statSync(opts.agentsDir).isDirectory()) {
    const linkPath = path.join(agentDir, "agents");
    try {
      const stat = lstatSync(linkPath);
      if (stat) unlinkSync(linkPath);
    } catch {
      // doesn't exist, fine
    }
    symlinkSync(path.resolve(opts.agentsDir), linkPath);
    debug("model_config", "debug", "Linked agents: %s → %s", linkPath, opts.agentsDir);
  }

  return agentDir;
}

/**
 * Read the user's global pi auth.json (subscription OAuth tokens) so the
 * isolated flow agent dir inherits them. Falls back to "{}" when absent or
 * unreadable, preserving the prior no-credential behavior.
 */
function readGlobalAuth(): string {
  const globalAuth =
    process.env.PI_GLOBAL_AUTH_JSON ?? path.join(homedir(), ".pi", "agent", "auth.json");
  try {
    if (existsSync(globalAuth)) {
      const raw = readFileSync(globalAuth, "utf-8");
      JSON.parse(raw); // validate; throw to fallback on corruption
      debug("model_config", "debug", "Inherited subscription auth from %s", globalAuth);
      return raw.endsWith("\n") ? raw : raw + "\n";
    }
  } catch (e) {
    debug("model_config", "debug", "Global auth not usable (%s); using empty auth", String(e));
  }
  return "{}\n";
}

export function precheckModels(
  referencedModels: readonly string[],
  agentDir: string,
  env: Record<string, string>,
  options: { replaceEnv?: boolean; redactErrors?: boolean } = {},
): void {
  const wanted = [...new Set(referencedModels.map(stripEffortSuffix).filter(Boolean))];
  if (wanted.length === 0) return;

  const res = spawnSync("pi", ["--list-models"], {
    env: { ...(options.replaceEnv ? {} : process.env), ...env, PI_CODING_AGENT_DIR: agentDir },
    encoding: "utf-8",
    timeout: 30_000,
  });

  if (res.error) {
    throw new Error(options.redactErrors ? "Model precheck failed to run" : `Model precheck failed to run pi --list-models: ${res.error.message}`);
  }

  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (stderr.includes("errors loading models.json")) {
    throw new Error(options.redactErrors ? "Invalid restricted model configuration" : `Invalid models.json:\n${stderr.trim()}`);
  }
  if ((res.status ?? 0) !== 0) {
    throw new Error(options.redactErrors
      ? `Model precheck failed (exit ${res.status ?? "unknown"})`
      : `Model precheck failed (pi --list-models exit ${res.status}):\n${(stderr || stdout).trim()}`);
  }

  const available = parseListModels(`${stdout}\n${stderr}`);
  const missing = wanted.filter((m) => !available.has(m));
  if (missing.length > 0) {
    if (options.redactErrors) throw new Error("Restricted model unavailable");
    const preview = [...available].sort().slice(0, 10).join(", ") || "none";
    throw new Error(
      `Model(s) unavailable: ${missing.join(", ")}. ` +
      `Ensure each is defined in models.json and its key env var is set. ` +
      `Available: ${preview}`,
    );
  }
}

export function stripEffortSuffix(model: string): string {
  const knownEfforts = new Set(["low", "medium", "high", "xhigh", "none", "auto"]);
  const idx = model.lastIndexOf(":");
  if (idx === -1) return model;
  const suffix = model.slice(idx + 1).toLowerCase();
  return knownEfforts.has(suffix) ? model.slice(0, idx) : model;
}

function parseListModels(stdout: string): Set<string> {
  const available = new Set<string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith("provider")) continue;
    const cols = trimmed.split(/\s+/);
    if (cols.length >= 2) available.add(`${cols[0]}/${cols[1]}`);
  }
  return available;
}
