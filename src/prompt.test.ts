import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { render, substituteVars, type PromptContext } from "./prompt.js";

function makeStage(overrides: Record<string, any> = {}) {
  return {
    id: "test",
    name: "test",
    type: 0,
    skills: [],
    task: undefined as string | undefined,
    prompt: "",
    session: { reuse: false, prompt: undefined },
    tools: undefined,
    excludeTools: undefined,
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

  it("substitutes templates artifact dir", () => {
    const ctx: PromptContext = {
      ...baseContext,
      artifacts: { ...baseContext.artifacts, templates: "/flow/templates" },
    };
    const stage = makeStage({ prompt: "Templates at ${templates}" });
    const result = render(stage, ctx, "/flow/tasks");
    expect(result).toBe("Templates at /flow/templates");
  });

  it("substituteVars renders only variables without task or divider", () => {
    const result = substituteVars("Continue ${work_dir} -> ${output_dir}", baseContext);
    expect(result).toBe("Continue /project -> /output");
    expect(result).not.toContain("Runtime Context");
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

  it("renders task content before rendered prompt", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "youngflow-prompt-"));
    try {
      writeFileSync(path.join(tmpDir, "task.md"), "TASK BODY\n");
      const stage = makeStage({ task: "task.md", prompt: "Context ${work_dir}" });
      const result = render(stage, baseContext, tmpDir);
      expect(result).toBe("TASK BODY\n\n---\n\n# Runtime Context\n\nContext /project");
      expect(result).toContain("\n\n---\n\n# Runtime Context\n\n");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not add runtime context heading for task-only stages", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "youngflow-prompt-"));
    try {
      writeFileSync(path.join(tmpDir, "task.md"), "TASK BODY\n");
      const stage = makeStage({ task: "task.md", prompt: "" });
      const result = render(stage, baseContext, tmpDir);
      expect(result).toBe("TASK BODY");
      expect(result).not.toContain("Runtime Context");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not add runtime context heading for prompt-only stages", () => {
    const stage = makeStage({ prompt: "Context ${work_dir}" });
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("Context /project");
    expect(result).not.toContain("Runtime Context");
  });

  it("returns empty string for no prompt and no task", () => {
    const stage = makeStage({});
    const result = render(stage, baseContext, "/flow/tasks");
    expect(result).toBe("");
  });
});
