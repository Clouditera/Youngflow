import { describe, it, expect } from "vitest";
import { render, type PromptContext } from "./prompt.js";

function makeStage(overrides: Record<string, any> = {}) {
  return {
    id: "test",
    name: "test",
    type: 0,
    skills: [],
    task: undefined as string | undefined,
    prompt: "",
    timeout: 1800,
    model: undefined,
    agent: undefined,
    routes: [],
    tasks: [],
    concurrency: undefined,
    errorStrategy: "stop",
    extensions: [],
    env: undefined,
    over: undefined,
    stateExtract: undefined,
    ...overrides,
  } as any;
}

const baseContext: PromptContext = {
  workDir: "/project",
  outputDir: "/output",
  flowInputs: { target: "libpng" },
  artifacts: { agents: "/flow/agents", skills: "/flow/skills", tasks: "/flow/tasks" },
};

describe("render", () => {
  it("substitutes engine built-ins", () => {
    const stage = makeStage({ prompt: "Work in ${work_dir}, output to ${output_dir}" });
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("Work in /project, output to /output");
  });

  it("substitutes flow inputs", () => {
    const stage = makeStage({ prompt: "Analyze ${flow_inputs.target}" });
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("Analyze libpng");
  });

  it("substitutes artifact dirs", () => {
    const stage = makeStage({ prompt: "Skills at ${skills}" });
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("Skills at /flow/skills");
  });

  it("substitutes iterate_file", () => {
    const ctx: PromptContext = { ...baseContext, iterateFile: "/data/item.yaml" };
    const stage = makeStage({ prompt: "Process ${iterate_file}" });
    const result = render(stage, ctx, "/flow/tasks");
    expect(result).toBe("Process /data/item.yaml");
  });

  it("replaces all occurrences of same variable", () => {
    const stage = makeStage({ prompt: "${work_dir}/a and ${work_dir}/b" });
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("/project/a and /project/b");
  });

  it("returns empty string for no prompt and no task", () => {
    const stage = makeStage({});
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("");
  });
});
