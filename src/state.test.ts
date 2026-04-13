import { describe, it, expect } from "vitest";
import { extractState, StateExtractionError } from "./state.js";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import yaml from "js-yaml";

describe("extractState", () => {
  let tmpDir: string;

  function setup() {
    tmpDir = path.join(os.tmpdir(), `youngflow-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  function teardown() {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  // ---- file + field ----

  it("extracts scalar from YAML file", () => {
    setup();
    writeFileSync(path.join(tmpDir, "output.yaml"), yaml.dump({
      is_valid: true,
      score: 42,
    }));

    const state = extractState({
      is_valid: { file: "output.yaml", field: "is_valid" },
      score: { file: "output.yaml", field: "score" },
    }, tmpDir);

    expect(state.is_valid).toBe(true);
    expect(state.score).toBe(42);
    teardown();
  });

  it("extracts nested field with dot path", () => {
    setup();
    writeFileSync(path.join(tmpDir, "data.yaml"), yaml.dump({
      analysis: { result: { count: 7 } },
    }));

    const state = extractState({
      count: { file: "data.yaml", field: "analysis.result.count" },
    }, tmpDir);

    expect(state.count).toBe(7);
    teardown();
  });

  it("throws on missing file (strict)", () => {
    setup();
    expect(() => extractState({
      val: { file: "missing.yaml", field: "x" },
    }, tmpDir)).toThrow(StateExtractionError);
    teardown();
  });

  it("throws on missing field", () => {
    setup();
    writeFileSync(path.join(tmpDir, "data.yaml"), yaml.dump({ a: 1 }));

    expect(() => extractState({
      val: { file: "data.yaml", field: "nonexistent" },
    }, tmpDir)).toThrow(StateExtractionError);
    teardown();
  });

  // ---- file + keys_of ----

  it("extracts keys from dict", () => {
    setup();
    writeFileSync(path.join(tmpDir, "features.yaml"), yaml.dump({
      items: { feat_a: { count: 5 }, feat_b: { count: 3 } },
    }));

    const state = extractState({
      feature_names: { file: "features.yaml", keys_of: "items" },
    }, tmpDir);

    expect(state.feature_names).toEqual(["feat_a", "feat_b"]);
    teardown();
  });

  it("filters keys with where clause", () => {
    setup();
    writeFileSync(path.join(tmpDir, "features.yaml"), yaml.dump({
      items: {
        high: { count: 10 },
        low: { count: 2 },
        mid: { count: 5 },
      },
    }));

    const state = extractState({
      high_features: { file: "features.yaml", keys_of: "items", where: "count >= 5" },
    }, tmpDir);

    expect(state.high_features).toEqual(expect.arrayContaining(["high", "mid"]));
    expect(state.high_features).not.toContain("low");
    teardown();
  });

  // ---- glob ----

  it("counts glob matches (lenient)", () => {
    setup();
    const subdir = path.join(tmpDir, "findings");
    mkdirSync(subdir);
    writeFileSync(path.join(subdir, "a.yaml"), "");
    writeFileSync(path.join(subdir, "b.yaml"), "");

    const state = extractState({
      finding_count: { glob: "findings/*.yaml" },
    }, tmpDir);

    expect(state.finding_count).toBe(2);
    teardown();
  });

  it("glob returns 0 for no matches (lenient, no throw)", () => {
    setup();
    const state = extractState({
      count: { glob: "nonexistent/**/*.yaml" },
    }, tmpDir);

    expect(state.count).toBe(0);
    teardown();
  });

  // ---- errors ----

  it("throws for rule with no data source", () => {
    setup();
    expect(() => extractState({
      bad: { something: "else" } as any,
    }, tmpDir)).toThrow(StateExtractionError);
    teardown();
  });

  it("throws for non-object rule", () => {
    expect(() => extractState({
      bad: "not_an_object" as any,
    }, "/tmp")).toThrow(StateExtractionError);
  });
});
