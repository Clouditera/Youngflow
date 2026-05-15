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
});
