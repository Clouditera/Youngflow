import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createRunId, hasActiveRun, validateRunModeOptions, parseRecursionLimit, resolveInputs, validateWorkDir } from "./cli.js";

describe("CLI run mode helpers", () => {
  it("formats run ids as UTC timestamps", () => {
    expect(createRunId(new Date(Date.UTC(2026, 4, 12, 3, 4, 5)))).toBe("20260512T030405Z");
  });

  it("rejects resume and continue together", () => {
    expect(() => validateRunModeOptions({ resume: true, continue: true })).toThrow(/mutually exclusive/);
  });

  it("allows resume or continue independently", () => {
    expect(() => validateRunModeOptions({ resume: true })).not.toThrow();
    expect(() => validateRunModeOptions({ continue: true })).not.toThrow();
  });

  it("ignores archived runs when detecting active runs", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "youngflow-cli-"));
    try {
      mkdirSync(path.join(tmp, ".youngflow", "runs", "20260512T030405Z"), { recursive: true });
      writeFileSync(path.join(tmp, ".youngflow", "runs", "20260512T030405Z", "run.yaml"), "status: success\n");
      expect(hasActiveRun(tmp)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("detects active run evidence", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "youngflow-cli-"));
    try {
      mkdirSync(path.join(tmp, ".youngflow", "logs"), { recursive: true });
      expect(hasActiveRun(tmp)).toBe(false);
      writeFileSync(path.join(tmp, ".youngflow", "logs", "stage.log"), "started\n");
      expect(hasActiveRun(tmp)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("parses valid recursion limits", () => {
    expect(parseRecursionLimit("200")).toBe(200);
  });

  it("rejects invalid recursion limits", () => {
    expect(() => parseRecursionLimit("0")).toThrow(/positive integer/);
    expect(() => parseRecursionLimit("-1")).toThrow(/positive integer/);
    expect(() => parseRecursionLimit("abc")).toThrow(/positive integer/);
  });

  it("detects active run metadata", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "youngflow-cli-"));
    try {
      mkdirSync(path.join(tmp, ".youngflow"), { recursive: true });
      writeFileSync(path.join(tmp, ".youngflow", "run.yaml"), "status: running\n");
      expect(hasActiveRun(tmp)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("validateWorkDir", () => {
  it("passes when work_dir exists and is a directory", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "youngflow-workdir-"));
    try {
      expect(() => validateWorkDir(tmp)).not.toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails clearly when work_dir does not exist", () => {
    const missing = path.join(os.tmpdir(), `youngflow-missing-${Date.now()}`);
    expect(() => validateWorkDir(missing)).toThrow(`Error: --work-dir does not exist: ${missing}`);
  });

  it("fails clearly when work_dir is a file", () => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "youngflow-workdir-file-"));
    try {
      const file = path.join(tmp, "not-a-dir");
      writeFileSync(file, "x", "utf-8");
      expect(() => validateWorkDir(file)).toThrow(`Error: --work-dir is not a directory: ${file}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveInputs declared defaults", () => {
  it("applies an input's declared default when no CLI value is given", () => {
    const spec = { enable_poc: { type: "str", default: "" } };
    const inputs = resolveInputs({}, spec);
    expect(inputs.enable_poc).toBe("");
  });

  it("applies non-empty declared defaults", () => {
    const spec = { max_items: { type: "str", default: "5" } };
    const inputs = resolveInputs({}, spec);
    expect(inputs.max_items).toBe("5");
  });

  it("lets a CLI value override the declared default", () => {
    const spec = { enable_poc: { type: "str", default: "" } };
    const inputs = resolveInputs({ enablePoc: "true" }, spec);
    expect(inputs.enable_poc).toBe("true");
  });
});
