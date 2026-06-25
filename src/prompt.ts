/**
 * Prompt rendering: template variable substitution + task.md assembly.
 *
 * Variables:
 *   ${work_dir}, ${output_dir}, ${iterate_file}, ${iterate_item}  — engine built-ins
 *   ${flow_inputs.xxx}                           — from flow.yaml inputs
 *   ${agents}, ${skills}, ${tasks}, etc.         — artifact dirs
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { StageSpec, TaskSpec } from "./spec.js";

export interface PromptContext {
  readonly workDir: string;
  readonly outputDir: string;
  readonly flowInputs: Record<string, any>;
  readonly iterateFile?: string;
  readonly iterateItem?: string;
  readonly artifacts?: Record<string, string>;
}

export function render(
  stage: StageSpec | TaskSpec,
  context: PromptContext,
  tasksDir: string,
): string {
  const parts: string[] = [];

  if (stage.task) {
    const taskPath = path.join(tasksDir, stage.task);
    if (existsSync(taskPath)) {
      parts.push(readFileSync(taskPath, "utf-8").trim());
    }
  }

  if (stage.prompt) {
    const rendered = substituteVars(stage.prompt.trim(), context);
    if (parts.length > 0 && rendered) {
      parts.push("---\n\n# Runtime Context");
    }
    parts.push(rendered);
  }

  return parts.join("\n\n");
}

export function substituteVars(text: string, context: PromptContext): string {
  const vars = buildVars(context);
  let rendered = text;
  for (const [key, value] of Object.entries(vars)) {
    rendered = rendered.replaceAll(`\${${key}}`, String(value));
  }
  return rendered;
}

function buildVars(context: PromptContext): Record<string, string> {
  const vars: Record<string, string> = {};

  // Flow inputs: ${flow_inputs.xxx}
  for (const [key, value] of Object.entries(context.flowInputs)) {
    vars[`flow_inputs.${key}`] = String(value);
  }

  // Engine built-ins
  vars["work_dir"] = context.workDir;
  vars["output_dir"] = context.outputDir;

  if (context.iterateFile) {
    vars["iterate_file"] = context.iterateFile;
  }
  if (context.iterateItem !== undefined) {
    vars["iterate_item"] = context.iterateItem;
  }

  // Artifact dirs
  if (context.artifacts) {
    for (const [key, p] of Object.entries(context.artifacts)) {
      vars[key] = p;
    }
  }

  return vars;
}
