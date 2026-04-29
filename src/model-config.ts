/**
 * Model configuration: translate .env model config into pi agent dir.
 *
 * Reads MODEL_PROTO_TYPE / LLM_MODEL_NAME / LLM_BASE_URL / LLM_API_KEY / MODEL_EFFORT,
 * creates .pi-agent/ with models.json + auth.json.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  unlinkSync,
  lstatSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { debug } from "./logger.js";

const API_KEY_ENV = "YOUNGFLOW_LLM_API_KEY";
const FALLBACK_PROVIDER = "youngflow";

const API_TYPE_MAP: Record<string, string> = {
  openai: "openai-completions",
  anthropic: "anthropic",
  // Pass-through: user already specified the exact pi-cli API type
  "openai-completions": "openai-completions",
  "openai-responses": "openai-responses",
};

const BUILTIN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "groq",
  "xai",
  "openrouter",
  "mistral",
]);

export interface ModelConfig {
  readonly modelString: string;
  readonly apiKey: string | undefined;
  readonly agentDir: string | undefined;
  readonly envVars: Record<string, string>;
}

export function resolveModelConfig(
  env: Record<string, string>,
  defaultModel: string,
  agentDirBase?: string,
  agentsDir?: string,
): ModelConfig {
  const proto = (env.MODEL_PROTO_TYPE ?? "").trim();
  const modelName = (env.LLM_MODEL_NAME ?? "").trim();
  const baseUrl = (env.LLM_BASE_URL ?? "").trim();
  const apiKey = (env.LLM_API_KEY ?? "").trim();
  const effort = (env.MODEL_EFFORT ?? "").trim();

  if (!proto && !modelName && !apiKey) {
    debug("model_config", "info", "No model config in .env — using default: %s", defaultModel);
    return { modelString: defaultModel, apiKey: undefined, agentDir: undefined, envVars: {} };
  }

  if (!modelName) {
    debug("model_config", "warning", "LLM_MODEL_NAME not set — using default: %s", defaultModel);
    return { modelString: defaultModel, apiKey: undefined, agentDir: undefined, envVars: {} };
  }

  const isCustom = !!baseUrl;
  const provider = isCustom ? (proto || FALLBACK_PROVIDER) : proto;
  let modelString = `${provider}/${modelName}`;
  if (effort) modelString += `:${effort}`;

  const envVars: Record<string, string> = {};
  if (apiKey) envVars[API_KEY_ENV] = apiKey;

  let agentDir: string | undefined;
  if (apiKey || isCustom) {
    const agentDirPath = createAgentDir({
      proto,
      modelName,
      baseUrl,
      apiKeyEnv: apiKey ? API_KEY_ENV : undefined,
      provider,
      isCustom,
      base: agentDirBase,
      agentsDir,
    });
    agentDir = agentDirPath;
    envVars["PI_CODING_AGENT_DIR"] = agentDir;
  }

  debug("model_config", "info", "Model config: model=%s provider=%s custom=%s agentDir=%s",
    modelString, provider, isCustom, agentDir ?? "(none)");

  return {
    modelString,
    apiKey: apiKey || undefined,
    agentDir,
    envVars,
  };
}

function createAgentDir(opts: {
  proto: string;
  modelName: string;
  baseUrl: string;
  apiKeyEnv?: string;
  provider: string;
  isCustom: boolean;
  base?: string;
  agentsDir?: string;
}): string {
  const agentDir = path.join(opts.base ?? process.cwd(), ".pi-agent");
  mkdirSync(agentDir, { recursive: true });

  // auth.json
  const authData: Record<string, any> = {};
  if (opts.apiKeyEnv && !opts.isCustom) {
    authData[opts.provider] = { type: "api_key", key: opts.apiKeyEnv };
  }
  writeFileSync(
    path.join(agentDir, "auth.json"),
    JSON.stringify(authData, null, 2),
    "utf-8",
  );

  // models.json
  let modelsData: Record<string, any>;
  if (opts.isCustom) {
    const apiType = API_TYPE_MAP[opts.proto];
    if (!apiType) {
      throw new Error(
        `Unknown MODEL_PROTO_TYPE: "${opts.proto}". ` +
        `Valid values: ${Object.keys(API_TYPE_MAP).join(", ")}`,
      );
    }
    const providerConfig: Record<string, any> = {
      baseUrl: opts.baseUrl,
      api: apiType,
      models: [
        {
          id: opts.modelName,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 16384,
        },
      ],
    };
    if (opts.apiKeyEnv) providerConfig.apiKey = opts.apiKeyEnv;
    modelsData = { providers: { [opts.provider]: providerConfig } };
  } else {
    modelsData = { providers: {} };
  }
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify(modelsData, null, 2),
    "utf-8",
  );

  // settings.json
  const settingsPath = path.join(agentDir, "settings.json");
  if (!existsSync(settingsPath)) {
    writeFileSync(settingsPath, "{}", "utf-8");
  }

  // agents/ symlink
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
