import type { FlowSpec, StageSpec } from "./spec.js";

const ENV_REF_RE = /\$\{env\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

export class EnvInterpolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvInterpolationError";
  }
}

export function resolveModelEnvReferences(
  spec: FlowSpec,
  env: Record<string, string | undefined>,
): FlowSpec {
  const defaultModel = resolveEnvRefs(spec.defaultModel, "defaults.model", env);
  let changed = defaultModel !== spec.defaultModel;

  const stages = spec.stages.map((stage) => {
    if (!stage.model) return stage;
    const model = resolveEnvRefs(stage.model, `stages[${stage.id}].model`, env);
    if (model === stage.model) return stage;
    changed = true;
    return { ...stage, model } as StageSpec;
  });

  if (!changed) return spec;
  return { ...spec, defaultModel, stages };
}

export function resolveEnvRefs(
  value: string,
  fieldPath: string,
  env: Record<string, string | undefined>,
): string {
  const resolved = value.replace(ENV_REF_RE, (_match, name: string) => {
    const envValue = env[name];
    if (envValue == null || envValue === "") {
      throw new EnvInterpolationError(`Missing env var ${name} for ${fieldPath}`);
    }
    return envValue;
  }).trim();

  if (resolved.length === 0) {
    throw new EnvInterpolationError(`Resolved empty model for ${fieldPath}`);
  }

  return resolved;
}
