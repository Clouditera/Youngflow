---
title: Implementation Plan — DeepSeek Custom Provider Thinking Compatibility v0.2.3
---

# Implementation Plan — DeepSeek Custom Provider Thinking Compatibility v0.2.3

Date: 2026-04-29  
Context: VulnHunt scan stages using DeepSeek V4 Pro through a custom OpenAI-compatible `LLM_BASE_URL` failed with:

```text
400 The `reasoning_content` in the thinking mode must be passed back to the API.
```

## Verdict

PR #25 has the correct root-cause direction: YoungFlow currently registers custom DeepSeek endpoints as `provider=youngflow`, so pi does not activate its DeepSeek thinking/reasoning compatibility path.

Adopt the fix, but keep it narrowly scoped:

- Custom DeepSeek endpoint → `provider=deepseek` + `reasoning:true` + DeepSeek `compat`.
- Non-DeepSeek custom endpoint → keep existing `provider=youngflow` behavior.
- Prefer `pi --thinking <level>` over `--model provider/model:<level>` going forward.

## Root Cause

VulnHunt passes credentials to YoungFlow roughly as:

```env
MODEL_PROTO_TYPE=openai
LLM_MODEL_NAME=deepseek-v4-pro
LLM_BASE_URL=<custom proxy URL>
LLM_API_KEY=...
MODEL_EFFORT=medium
```

Old YoungFlow behavior produced:

```text
--model youngflow/deepseek-v4-pro:medium
```

and generated `.pi-agent/models.json` with provider `youngflow`.

pi's existing DeepSeek compatibility is activated when it can detect DeepSeek, e.g.:

```ts
provider === "deepseek" || baseUrl.includes("deepseek.com")
```

With a custom proxy URL, neither condition is true. pi therefore treats the model as a generic OpenAI-compatible model and does not:

- send DeepSeek thinking parameters;
- replay assistant `reasoning_content` in subsequent requests;
- disable unsupported `developer` role.

When `MODEL_EFFORT` enables thinking, DeepSeek returns `reasoning_content`; after a tool call, DeepSeek requires that `reasoning_content` be passed back in later turns. Generic provider replay omits it, causing the 400 error.

## Design Principles

1. **Do not change behavior for unrelated providers.** Qwen, MiniMax, OpenRouter proxies, and other custom endpoints should continue to use the generic `youngflow` custom provider unless explicitly detected as DeepSeek.
2. **Separate model identity from runtime thinking level.** Use `--model provider/model` plus `--thinking medium`; avoid embedding runtime settings in `modelString`.
3. **Generate self-contained pi model config.** Do not rely only on pi's implicit provider detection; include the DeepSeek compat fields in generated `models.json`.
4. **Do not retry protocol/configuration errors.** The `reasoning_content` 400 will repeat when resuming the same session, so it should be classified non-retryable.

## Proposed Code Changes

### 1. `src/model-config.ts` — preserve generic custom provider, detect DeepSeek only

Add helpers:

```ts
const CUSTOM_PROVIDER = "youngflow";

const DEEPSEEK_REASONING_EFFORT_MAP = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "max",
};

function isDeepSeekLike(modelName: string, baseUrl: string): boolean {
  const model = modelName.toLowerCase();
  const url = baseUrl.toLowerCase();
  return (
    model === "deepseek" ||
    model.startsWith("deepseek-") ||
    model.startsWith("deepseek/") ||
    model.startsWith("deepseek-ai/") ||
    url.includes("deepseek")
  );
}
```

Provider selection should be:

```ts
const isCustom = !!baseUrl;
const isDeepSeekCustom = isCustom && isDeepSeekLike(modelName, baseUrl);
const provider = isCustom ? (isDeepSeekCustom ? "deepseek" : CUSTOM_PROVIDER) : proto;
```

Do **not** use `proto` as the custom provider for non-DeepSeek models. Current PR #25 changes custom `MODEL_PROTO_TYPE=openai` to `provider=openai`; that is too broad and should be avoided.

### 2. `src/model-config.ts` — model string and thinking level separation

Change `ModelConfig` to carry thinking separately:

```ts
export interface ModelConfig {
  readonly modelString: string;
  readonly thinkingLevel: string | undefined;
  readonly apiKey: string | undefined;
  readonly agentDir: string | undefined;
  readonly envVars: Record<string, string>;
}
```

Generate:

```ts
const thinkingLevel = (env.MODEL_EFFORT ?? "").trim() || undefined;
const modelString = `${provider}/${modelName}`;
```

No longer append `:${effort}` to `modelString`.

Rationale: pi supports `--model provider/model:thinking`, so the old form is valid, but `--thinking` is clearer and keeps model identity separate from runtime behavior.

### 3. `src/model-config.ts` — generated DeepSeek model config

For DeepSeek custom models, generate:

```json
{
  "id": "deepseek-v4-pro",
  "input": ["text"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "reasoning": true,
  "compat": {
    "supportsDeveloperRole": false,
    "requiresReasoningContentOnAssistantMessages": true,
    "thinkingFormat": "deepseek",
    "reasoningEffortMap": {
      "minimal": "high",
      "low": "high",
      "medium": "high",
      "high": "high",
      "xhigh": "max"
    }
  }
}
```

Field meaning:

- `reasoning:true` makes pi treat the model as thinking-capable; otherwise `MODEL_EFFORT` / `--thinking` is effectively disabled.
- `thinkingFormat:"deepseek"` makes pi send DeepSeek's thinking request format: `thinking: { type: "enabled" }` and `reasoning_effort`.
- `reasoningEffortMap` maps pi thinking levels to DeepSeek's supported effort values.
- `requiresReasoningContentOnAssistantMessages:true` makes pi replay assistant `reasoning_content`; this is the direct fix for the 400.
- `supportsDeveloperRole:false` avoids DeepSeek rejecting unsupported `developer` role.

### 4. `src/runner.ts` — pass `--thinking` explicitly

Update command construction from:

```bash
pi --model deepseek/deepseek-v4-pro:medium
```

to:

```bash
pi --model deepseek/deepseek-v4-pro --thinking medium
```

Suggested implementation:

```ts
cmd.push("--model", modelStr);
const thinking = config.thinkingLevel ?? this.modelConfig.thinkingLevel;
if (thinking) {
  cmd.push("--thinking", thinking);
}
```

If introducing `RunConfig.thinkingLevel` is too much for v0.2.3, using only `this.modelConfig.thinkingLevel` is acceptable. Keep stage-level override as a future extension.

Passing `--thinking off` explicitly is acceptable and clearer if `MODEL_EFFORT=off` is set.

### 5. `src/runner.ts` — classify DeepSeek protocol error as non-retryable

Add this error to `NON_RETRYABLE_RE`:

```regex
reasoning_content.*thinking mode.*passed back
```

Reason: retrying the same session cannot fix a missing replay field; it only repeats the same 400.

## Test Plan

Add tests rather than only relying on manual verification.

### Model config tests

Create or extend `src/model-config.test.ts`.

Required cases:

1. DeepSeek custom endpoint:

```env
MODEL_PROTO_TYPE=openai
LLM_MODEL_NAME=deepseek-v4-pro
LLM_BASE_URL=https://proxy.example/v1
MODEL_EFFORT=medium
```

Expected:

- `modelString === "deepseek/deepseek-v4-pro"`
- `thinkingLevel === "medium"`
- `models.json.providers.deepseek` exists
- model has `reasoning:true`
- model has compat fields listed above

2. Non-DeepSeek custom endpoint, e.g. Qwen:

```env
MODEL_PROTO_TYPE=openai
LLM_MODEL_NAME=qwen3-coder
LLM_BASE_URL=https://proxy.example/v1
MODEL_EFFORT=medium
```

Expected:

- `modelString === "youngflow/qwen3-coder"`
- provider key remains `youngflow`
- no DeepSeek `reasoning/compat` fields are injected

3. Base URL detection:

```env
MODEL_PROTO_TYPE=openai
LLM_MODEL_NAME=v4-pro
LLM_BASE_URL=https://deepseek-proxy.example/v1
```

Expected provider: `deepseek`.

4. No broad provider change:

Custom `MODEL_PROTO_TYPE=openai` must not produce `provider=openai` unless it is a standard non-custom config.

### Runner command tests

Add/extend `src/runner.test.ts` to verify command generation:

```text
--model deepseek/deepseek-v4-pro --thinking medium
```

and not:

```text
--model deepseek/deepseek-v4-pro:medium
```

### Error classification test

Add/extend `classifyError()` tests:

```ts
lastError: "400 The `reasoning_content` in the thinking mode must be passed back to the API."
```

Expected: `ErrorKind.NON_RETRYABLE`.

## Acceptance Criteria

- `npm test` passes.
- `npm run build` passes.
- Generated `.pi-agent/models.json` for custom DeepSeek includes `provider=deepseek`, `reasoning:true`, and full DeepSeek compat.
- Generated pi command uses `--thinking` rather than `model:effort` for env-driven `MODEL_EFFORT`.
- Qwen/MiniMax custom endpoints still use generic `provider=youngflow`.
- DeepSeek `reasoning_content` 400 is non-retryable.
- A DeepSeek V4 Pro custom endpoint scan with tool calls no longer fails on session replay.

## Release / Rollout Checklist

1. Merge the narrowed PR.
2. Bump YoungFlow to `0.2.3`.
3. Build release binary:

```bash
PKG_TARGETS=node20-linux-x64 npm run build:binary
./release/youngflow-linux-x64 --version
```

4. Push tag/release binary.
5. Update VulnHunt `submodules/youngflow` to v0.2.3.
6. Rebuild `vulnhunt-worker` and `vulnhunt-eval-worker` images.
7. Verify inside images:

```bash
docker run --rm --entrypoint youngflow vulnhunt-worker:latest --version
```

8. Smoke test with DeepSeek custom endpoint + `MODEL_EFFORT=medium`.

## Notes

This fix is independent of the previous `.events.jsonl` mitigation. The raw event logging issue was resolved by defaulting off per-stage trace event files; this plan addresses DeepSeek thinking-mode session replay compatibility.
