import { describe, it, expect } from "vitest";
import { engineConfigFromEnv } from "./engine-config.js";

describe("engineConfigFromEnv", () => {
  it("returns defaults with empty env", () => {
    const cfg = engineConfigFromEnv({});
    expect(cfg.errorRetries).toBe(2);
    expect(cfg.errorRetryBackoff).toBe(5);
    expect(cfg.idleTimeout).toBe(300);
    expect(cfg.exportSessions).toBe(true);
  });

  it("reads YOUNGFLOW_* env vars", () => {
    const cfg = engineConfigFromEnv({
      YOUNGFLOW_ERROR_RETRIES: "5",
      YOUNGFLOW_ERROR_RETRY_BACKOFF: "10",
      YOUNGFLOW_IDLE_TIMEOUT: "60",
      YOUNGFLOW_EXPORT_SESSIONS: "false",
    });
    expect(cfg.errorRetries).toBe(5);
    expect(cfg.errorRetryBackoff).toBe(10);
    expect(cfg.idleTimeout).toBe(60);
    expect(cfg.exportSessions).toBe(false);
  });

  it("handles exportSessions variants", () => {
    expect(engineConfigFromEnv({ YOUNGFLOW_EXPORT_SESSIONS: "0" }).exportSessions).toBe(false);
    expect(engineConfigFromEnv({ YOUNGFLOW_EXPORT_SESSIONS: "no" }).exportSessions).toBe(false);
    expect(engineConfigFromEnv({ YOUNGFLOW_EXPORT_SESSIONS: "1" }).exportSessions).toBe(true);
    expect(engineConfigFromEnv({ YOUNGFLOW_EXPORT_SESSIONS: "yes" }).exportSessions).toBe(true);
  });

  it("result is frozen", () => {
    const cfg = engineConfigFromEnv({});
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
