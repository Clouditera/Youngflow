/**
 * Centralized engine runtime configuration.
 *
 * All YOUNGFLOW_* env vars resolved into a single frozen object.
 * Constructed once by Orchestrator, passed to Runner/Executor.
 */

export interface EngineConfig {
  readonly errorRetries: number;
  readonly errorRetryBackoff: number;
  readonly idleTimeout: number;
  readonly exportSessions: boolean;
}

export function engineConfigFromEnv(env: Record<string, string>): EngineConfig {
  return Object.freeze({
    errorRetries: parseInt(
      env.YOUNGFLOW_ERROR_RETRIES ?? env.YOUNGFLOW_EMPTY_RETRIES ?? "2",
      10,
    ),
    errorRetryBackoff: parseFloat(
      env.YOUNGFLOW_ERROR_RETRY_BACKOFF ??
        env.YOUNGFLOW_EMPTY_RETRY_BACKOFF ??
        "5",
    ),
    idleTimeout: parseInt(env.YOUNGFLOW_IDLE_TIMEOUT ?? "300", 10),
    exportSessions: !["0", "false", "no"].includes(
      env.YOUNGFLOW_EXPORT_SESSIONS ?? "1",
    ),
  });
}
