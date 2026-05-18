import { describe, it, expect } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveModelConfig } from "./model-config.js";

function tmpDir(name: string): string {
  const dir = path.join(os.tmpdir(), `youngflow-model-config-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return dir;
}

function readModelsJson(agentDir: string): any {
  return JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf-8"));
}

describe("resolveModelConfig", () => {
  it("detects DeepSeek custom endpoint and writes reasoning compat", () => {
    const dir = tmpDir("deepseek");
    try {
      const config = resolveModelConfig({
        MODEL_PROTO_TYPE: "openai",
        LLM_MODEL_NAME: "deepseek-v4-pro",
        LLM_BASE_URL: "https://proxy.example/v1",
        LLM_API_KEY: "secret",
        MODEL_EFFORT: "medium",
      }, "anthropic/claude", dir);

      expect(config.modelString).toBe("deepseek/deepseek-v4-pro");
      expect(config.thinkingLevel).toBe("medium");
      expect(config.agentDir).toBe(path.join(dir, ".pi-agent"));

      const models = readModelsJson(config.agentDir!);
      const provider = models.providers.deepseek;
      expect(provider).toBeDefined();
      expect(provider.baseUrl).toBe("https://proxy.example/v1");
      expect(provider.api).toBe("openai-completions");
      const model = provider.models[0];
      expect(model.id).toBe("deepseek-v4-pro");
      expect(model.reasoning).toBe(true);
      expect(model.compat).toEqual({
        supportsDeveloperRole: false,
        requiresReasoningContentOnAssistantMessages: true,
        thinkingFormat: "deepseek",
        reasoningEffortMap: {
          minimal: "high",
          low: "high",
          medium: "high",
          high: "high",
          xhigh: "max",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps non-DeepSeek custom endpoint on youngflow provider without DeepSeek compat", () => {
    const dir = tmpDir("qwen");
    try {
      const config = resolveModelConfig({
        MODEL_PROTO_TYPE: "openai",
        LLM_MODEL_NAME: "qwen3-coder",
        LLM_BASE_URL: "https://proxy.example/v1",
        MODEL_EFFORT: "medium",
      }, "anthropic/claude", dir);

      expect(config.modelString).toBe("youngflow/qwen3-coder");
      expect(config.thinkingLevel).toBe("medium");

      const models = readModelsJson(config.agentDir!);
      expect(models.providers.youngflow).toBeDefined();
      expect(models.providers.openai).toBeUndefined();
      const model = models.providers.youngflow.models[0];
      expect(model.reasoning).toBeUndefined();
      expect(model.compat).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects DeepSeek from custom base URL", () => {
    const dir = tmpDir("deepseek-url");
    try {
      const config = resolveModelConfig({
        MODEL_PROTO_TYPE: "openai",
        LLM_MODEL_NAME: "v4-pro",
        LLM_BASE_URL: "https://deepseek-proxy.example/v1",
      }, "anthropic/claude", dir);

      expect(config.modelString).toBe("deepseek/v4-pro");
      const models = readModelsJson(config.agentDir!);
      expect(models.providers.deepseek).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not broadly change custom MODEL_PROTO_TYPE=openai to provider=openai", () => {
    const dir = tmpDir("openai-custom");
    try {
      const config = resolveModelConfig({
        MODEL_PROTO_TYPE: "openai",
        LLM_MODEL_NAME: "gpt-custom",
        LLM_BASE_URL: "https://proxy.example/v1",
      }, "anthropic/claude", dir);

      expect(config.modelString).toBe("youngflow/gpt-custom");
      const models = readModelsJson(config.agentDir!);
      expect(models.providers.youngflow).toBeDefined();
      expect(models.providers.openai).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes contextWindow from LLM_CONTEXT_WINDOW_TOKENS", () => {
    const dir = tmpDir("context-window");
    try {
      const config = resolveModelConfig({
        MODEL_PROTO_TYPE: "openai",
        LLM_MODEL_NAME: "qwen3-coder",
        LLM_BASE_URL: "https://proxy.example/v1",
        LLM_CONTEXT_WINDOW_TOKENS: "256000",
      }, "anthropic/claude", dir);

      const models = readModelsJson(config.agentDir!);
      expect(models.providers.youngflow.models[0].contextWindow).toBe(256000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to 128000 for invalid context window env", () => {
    const dir = tmpDir("context-window-invalid");
    try {
      const config = resolveModelConfig({
        MODEL_PROTO_TYPE: "openai",
        LLM_MODEL_NAME: "qwen3-coder",
        LLM_BASE_URL: "https://proxy.example/v1",
        LLM_CONTEXT_WINDOW_TOKENS: "invalid",
      }, "anthropic/claude", dir);

      const models = readModelsJson(config.agentDir!);
      expect(models.providers.youngflow.models[0].contextWindow).toBe(128000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
