import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseFlow } from "./spec.js";

function makeFlowDir(): string {
  const dir = path.join(os.tmpdir(), `youngflow-spec-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, "agents"), { recursive: true });
  mkdirSync(path.join(dir, "skills", "test-skill"), { recursive: true });
  writeFileSync(path.join(dir, "agents", "agent.md"), "You are a test agent.\n");
  writeFileSync(path.join(dir, "skills", "test-skill", "SKILL.md"), "# Test skill\n");
  return dir;
}

describe("parseFlow", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("parses optional flow-level timeout", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "timeout: 42",
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.timeout).toBe(42);
    expect(spec.stages[0].timeout).toBe(1800);
  });

  it("parses optional models_json artifact path", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    writeFileSync(path.join(dir, "models.json"), "{\"providers\":{}}\n");
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "artifacts:",
      "  models_json: models.json",
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.modelsJsonPath).toBe(path.join(dir, "models.json"));
  });

  it("parses optional templates artifact path", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "artifacts:",
      "  templates: templates",
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.templatesDir).toBe(path.join(dir, "templates"));
  });

  it("leaves templates artifact path undefined when omitted", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.templatesDir).toBeUndefined();
  });

  it("parses default exclude_tools denylist", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "  exclude_tools: [coverage]",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.defaultExcludeTools).toEqual(["coverage"]);
  });

  it("parses default compaction settings", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "  compaction:",
      "    enabled: true",
      "    reserve_tokens: 40000",
      "    keep_recent_tokens: 12000",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.compaction).toEqual({
      enabled: true,
      reserveTokens: 40000,
      keepRecentTokens: 12000,
    });
  });

  it("leaves default compaction undefined when omitted", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.compaction).toBeUndefined();
  });

  it("parses stage tools allowlist", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    tools: [read, coverage]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].tools).toEqual(["read", "coverage"]);
  });

  it("defaults omitted stage tools to undefined", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].tools).toBeUndefined();
  });

  it("parses stage exclude_tools denylist", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    exclude_tools: [coverage]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].excludeTools).toEqual(["coverage"]);
  });

  it("parses parallel task tools allowlist", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: fanout",
      "    type: parallel",
      "    tasks:",
      "      - id: left",
      "        skills: [test-skill]",
      "        tools: [read, coverage]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].tasks[0].tools).toEqual(["read", "coverage"]);
  });

  it("parses parallel task exclude_tools denylist", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: fanout",
      "    type: parallel",
      "    tasks:",
      "      - id: left",
      "        skills: [test-skill]",
      "        exclude_tools: [coverage]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].tasks[0].excludeTools).toEqual(["coverage"]);
  });

  it("parses stage session reuse config", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    session:",
      "      reuse: true",
      "      prompt: Continue ${work_dir}",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].session.reuse).toBe(true);
    expect(spec.stages[0].session.prompt).toBe("Continue ${work_dir}");
  });

  it("parses session compact_at", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    session:",
      "      compact_at: 0.7",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].session.compactAt).toBe(0.7);
  });

  it("rejects invalid session compact_at", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    session:",
      "      compact_at: 1.5",
    ].join("\n"));

    expect(() => parseFlow(flowPath)).toThrow(/compact_at/);
  });

  it("defaults omitted session config", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].session).toEqual({ reuse: false, prompt: undefined, compactAt: undefined });
  });

  it("parses parallel task session prompt", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: fanout",
      "    type: parallel",
      "    tasks:",
      "      - id: left",
      "        skills: [test-skill]",
      "        session:",
      "          prompt: Continue left",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].tasks[0].session).toEqual({ reuse: false, prompt: "Continue left", compactAt: undefined });
  });

  it("leaves flow-level timeout undefined when omitted", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.timeout).toBeUndefined();
    expect(spec.recursionLimit).toBeUndefined();
  });

  it("parses optional flow-level recursion_limit", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "recursion_limit: 200",
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.recursionLimit).toBe(200);
  });

  it("rejects invalid flow-level recursion_limit", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "recursion_limit: 0",
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
    ].join("\n"));

    expect(() => parseFlow(flowPath)).toThrow(/recursion_limit/);
  });

  it("accepts join stages without skills", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    routes:",
      "      - to: joiner",
      "  - id: joiner",
      "    type: join",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[1].type).toBe("join");
    expect(spec.stages[1].skills).toEqual([]);
  });

  it("still requires max_loops for backward routes from join", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: first",
      "    skills: [test-skill]",
      "    routes:",
      "      - to: joiner",
      "  - id: joiner",
      "    type: join",
      "    routes:",
      "      - to: first",
    ].join("\n"));

    expect(() => parseFlow(flowPath)).toThrow(/requires max_loops/);
  });

  it("parses map glob over source", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: review",
      "    type: map",
      "    skills: [test-skill]",
      "    over: findings/*.yaml",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].over).toBe("findings/*.yaml");
    expect(spec.stages[0].overSource).toEqual({ kind: "glob", pattern: "findings/*.yaml" });
  });

  it("parses map yaml-list over source", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: review",
      "    type: map",
      "    skills: [test-skill]",
      "    over:",
      "      yaml: decision.yaml",
      "      path: dispatch.items",
    ].join("\n"));

    const spec = parseFlow(flowPath);
    expect(spec.stages[0].over).toBeUndefined();
    expect(spec.stages[0].overSource).toEqual({ kind: "yaml", file: "decision.yaml", path: "dispatch.items" });
  });

  it("rejects filter with yaml-list over source", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: review",
      "    type: map",
      "    skills: [test-skill]",
      "    over:",
      "      yaml: decision.yaml",
      "      path: dispatch",
      "    filter:",
      "      field: status",
      "      match: pending",
    ].join("\n"));

    expect(() => parseFlow(flowPath)).toThrow(/filter is only supported with file-glob 'over'/);
  });

  function writeMapFilterFlow(dir: string, filterLines: string[]): string {
    const flowPath = path.join(dir, "flow.yaml");
    writeFileSync(flowPath, [
      'version: "1.0"',
      "defaults:",
      "  agent: agent.md",
      "stages:",
      "  - id: review",
      "    type: map",
      "    skills: [test-skill]",
      "    over: findings/*.yaml",
      "    filter:",
      ...filterLines.map((line) => `      ${line}`),
    ].join("\n"));
    return flowPath;
  }

  it("parses map filter match and defaults include_missing to false", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    const spec = parseFlow(writeMapFilterFlow(dir, [
      "field: metadata.review_status",
      "match: pending",
    ]));

    expect(spec.stages[0].filter).toEqual({
      field: "metadata.review_status",
      match: "pending",
      notMatch: undefined,
      in: undefined,
      notIn: undefined,
      includeMissing: false,
    });
  });

  it("parses map filter not_match, in, and not_in", () => {
    for (const filterLines of [
      ["field: status", "not_match: reproduced"],
      ["field: status", "in: [pending, new]"],
      ["field: status", "not_in: [reproduced, dismissed]", "include_missing: true"],
    ]) {
      const dir = makeFlowDir();
      tmpDirs.push(dir);
      const spec = parseFlow(writeMapFilterFlow(dir, filterLines));
      expect(spec.stages[0].filter?.field).toBe("status");
    }
  });

  it("rejects map filter with multiple operators", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    expect(() => parseFlow(writeMapFilterFlow(dir, [
      "field: status",
      "match: pending",
      "not_match: reproduced",
    ]))).toThrow(/mutually exclusive/);
  });

  it("rejects map filter without an operator", () => {
    const dir = makeFlowDir();
    tmpDirs.push(dir);
    expect(() => parseFlow(writeMapFilterFlow(dir, [
      "field: status",
    ]))).toThrow(/requires one of match\/not_match\/in\/not_in/);
  });
});
