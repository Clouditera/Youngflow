/**
 * CLI entry point: argument parsing, flow loading, orchestrator launch.
 *
 * CLI flags are generated from flow.yaml's `inputs` section.
 * Engine built-in inputs (work_dir, output_dir) have auto-filled defaults.
 */

import { existsSync, readFileSync, statSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import yaml from "js-yaml";
import fg from "fast-glob";
import { parseFlow } from "./spec.js";
import { Orchestrator } from "./orchestrator.js";
import * as report from "./report.js";
import { setLevel, attachFileHandler, enableJsonLog, logEvent, logFlowMessage, LogLevel } from "./logger.js";



function loadVersion(): string {
  try {
    const thisDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(thisDir, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const VERSION = loadVersion();

const ENGINE_DEFAULTS: Record<string, () => string> = {
  work_dir: () => process.cwd(),
  output_dir: () => {
    const ts = new Date()
      .toISOString()
      .replace(/[-:T]/g, "")
      .slice(0, 15);
    return path.join(process.cwd(), ".workspace", "runs", `run_${ts}`);
  },
};

export function main(): void {
  const args = process.argv.slice(2);

  // Version check
  if (args.includes("-V") || args.includes("--version")) {
    console.log(`youngflow ${VERSION}`);
    process.exit(0);
  }

  // Find flow path (first non-flag arg)
  const flowArg = args.find((a) => !a.startsWith("-"));
  if (!flowArg) {
    console.log(`youngflow ${VERSION}`);
    console.log();
    console.log("Usage: youngflow <flow.yaml | flow-dir/> [options]");
    console.log();
    console.log("Options:");
    console.log(`  ${"--until STAGE".padEnd(25)} Run stages up to STAGE`);
    console.log(`  ${"--resume".padEnd(25)} Resume from last checkpoint`);
    console.log(`  ${"--max-parallel N".padEnd(25)} Override max parallel`);
    console.log(`  ${"--list-stages".padEnd(25)} List stages and exit`);
    console.log(`  ${"--json-log".padEnd(25)} Output structured NDJSON to stderr`);
    console.log(`  ${"--trace-events".padEnd(25)} Save compacted raw pi event stream per stage`);
    console.log(`  ${"-V, --version".padEnd(25)} Show version and exit`);
    console.log();
    console.log("Pass a flow.yaml to see flow-specific input options.");
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  let flowYaml = path.resolve(flowArg);
  if (
    existsSync(flowYaml) &&
    statSync(flowYaml).isDirectory()
  ) {
    flowYaml = path.join(flowYaml, "flow.yaml");
  }
  if (!existsSync(flowYaml)) {
    console.error(`Error: not found: ${flowYaml}`);
    process.exit(1);
  }

  const raw = yaml.load(readFileSync(flowYaml, "utf-8")) as Record<
    string,
    any
  >;
  const flowInputsSpec = raw.inputs ?? {};

  // Build CLI with commander
  const program = new Command();
  program.name("youngflow").version(VERSION, "-V, --version");

  program
    .argument("<flow>", "Flow definition YAML")
    .option("--until <stage>", "Run stages up to STAGE")
    .option("--resume", "Resume from checkpoint")
    .option("--max-parallel <n>", "Override max parallel", parseInt)
    .option("--list-stages", "List stages and exit")
    .option("-v, --verbose", "Verbose logging")
    .option("--json-log", "Output structured NDJSON to stderr")
    .option("--trace-events", "Save compacted raw pi NDJSON event stream per stage");

  // Dynamic flags from flow inputs
  for (const [key, spec] of Object.entries(flowInputsSpec)) {
    const s = typeof spec === "object" && spec !== null ? (spec as any) : {};
    const flag = `--${key.replace(/_/g, "-")}`;
    const desc = s.description ?? "";
    if (s.type === "list") {
      program.option(`${flag} <items...>`, desc);
    } else {
      program.option(`${flag} <value>`, desc);
    }
  }

  program.parse(process.argv);
  const opts = program.opts();

  if (opts.listStages) {
    listStages(flowYaml, flowInputsSpec, raw);
    return;
  }

  // Resolve flow inputs
  const flowInputs = resolveInputs(opts, flowInputsSpec);

  // Validate
  if (opts.resume && !flowInputs.output_dir) {
    console.error("Error: --resume requires --output-dir");
    process.exit(1);
  }

  if (opts.until) {
    const stageIds = (raw.stages ?? []).map((s: any) => s.id);
    if (!stageIds.includes(opts.until)) {
      console.error(
        `Error: unknown stage '${opts.until}'. Available: ${stageIds.join(", ")}`,
      );
      process.exit(1);
    }
  }

  runFlow(flowYaml, flowInputs, opts).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

function resolveInputs(
  opts: Record<string, any>,
  spec: Record<string, any>,
): Record<string, any> {
  const inputs: Record<string, any> = {};
  for (const [key, s] of Object.entries(spec)) {
    const sp = typeof s === "object" && s !== null ? (s as any) : {};
    // Commander converts --work-dir to workDir
    const camelKey = key.replace(/-/g, "_");
    const optKey = camelKey.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    let value = opts[optKey] ?? opts[key] ?? opts[camelKey];

    if (value == null && key in ENGINE_DEFAULTS) {
      value = ENGINE_DEFAULTS[key]();
    }

    if (sp.required && !value && !(key in ENGINE_DEFAULTS)) {
      console.error(`Error: --${key.replace(/_/g, "-")} is required`);
      process.exit(1);
    }

    if (sp.type === "path" && value) {
      value = path.resolve(String(value));
    }

    if (value != null) {
      if (Array.isArray(value)) {
        inputs[key] = value;
      } else {
        inputs[key] = String(value);
      }
    }
  }
  return inputs;
}

async function runFlow(
  flowYaml: string,
  flowInputs: Record<string, any>,
  opts: Record<string, any>,
): Promise<void> {
  const workDir = flowInputs.work_dir ?? process.cwd();
  const outputDir = flowInputs.output_dir ?? workDir;

  // Setup logging first — before any initialization that may emit events
  if (opts.verbose) setLevel(LogLevel.DEBUG);
  if (opts.jsonLog) {
    enableJsonLog();
    jsonMode = true;
  }

  const spec = parseFlow(flowYaml, opts.until);

  // Guard: non-resume into existing run
  if (!opts.resume && hasPreviousRun(outputDir)) {
    console.error(
      `Error: output directory already contains a previous run:\n` +
        `  ${outputDir}\n\n` +
        `Options:\n` +
        `  --resume              Resume the previous run\n` +
        `  --output-dir <path>   Use a different output directory`,
    );
    process.exit(1);
  }

  const orch = new Orchestrator(spec, flowInputs, {
    workDir,
    outputDir,
    resume: opts.resume,
    maxParallel: opts.maxParallel,
    traceEvents: opts.traceEvents,
  });

  attachFileHandler(orch.workspace.flowLog);

  logEvent({
    category: "engine",
    event: "flow_start",
    flow: flowYaml,
    work_dir: workDir,
    output_dir: outputDir,
    model: orch.model,
    max_parallel: orch.maxParallel,
    resume: !!opts.resume,
  });

  log(`🔍 YoungFlow v${VERSION}`);
  log(`   Flow:     ${flowYaml}`);
  for (const [k, v] of Object.entries(flowInputs)) {
    log(`   ${k}: ${v}`);
  }
  log(`   Model:    ${orch.model}`);
  log(`   Parallel: ${orch.maxParallel}`);
  if (opts.until) log(`   Until:    ${opts.until}`);
  if (opts.resume) {
    const completed = orch.checkpoint.completedStages();
    log(
      `   Resume:   yes (completed: ${completed.length ? completed.join(", ") : "none"})`,
    );
  }
  log("");

  const start = Date.now();
  const result = await orch.run();
  const elapsed = ((Date.now() - start) / 1000).toFixed(0);

  const stagesCompleted = result.stageResults.filter(
    (r: Record<string, any>) => (r.exit_code ?? 0) === 0,
  ).length;
  const stagesFailed = result.stageResults.filter(
    (r: Record<string, any>) => (r.exit_code ?? 0) !== 0 && !r.skipped,
  ).length;

  logEvent({
    category: "engine",
    event: "flow_end",
    duration_ms: Date.now() - start,
    stages_total: result.stageResults.length,
    stages_completed: stagesCompleted,
    stages_failed: stagesFailed,
  });

  log("");
  log("=".repeat(60));
  log(`🏁 Flow complete (${elapsed}s)`);
  log("=".repeat(60));

  for (const sr of result.stageResults) {
    const status = sr.exit_code === 0 ? "✅" : "❌";
    const sessionFile = sr.session_file ?? "";
    const htmlFile = sessionFile
      ? sessionFile.replace(".jsonl", ".html")
      : "";
    let line = `${status} ${sr.id} (${sr.duration_ms ?? 0}ms)`;
    if (htmlFile && existsSync(htmlFile)) {
      line += `  → ${htmlFile}`;
    }
    log(line);
  }

  const reportPath = report.refresh(spec, orch.workspace);
  if (reportPath) log(`\n📊 Report: ${reportPath}`);
  log(`📂 Output: ${outputDir}`);
  log(`📝 Log:    ${orch.workspace.flowLog}`);
}

function listStages(
  flowYaml: string,
  inputsSpec: Record<string, any>,
  raw: Record<string, any>,
): void {
  const stages = raw.stages ?? [];
  console.log(`Flow: ${flowYaml}\n`);

  if (Object.keys(inputsSpec).length > 0) {
    console.log("Inputs:");
    for (const [key, s] of Object.entries(inputsSpec)) {
      const sp = typeof s === "object" && s !== null ? (s as any) : {};
      const flag = `--${key.replace(/_/g, "-")}`;
      const req =
        sp.required && !(key in ENGINE_DEFAULTS) ? " (required)" : "";
      const desc = sp.description ?? "";
      const engine = key in ENGINE_DEFAULTS ? " [engine]" : "";
      console.log(`  ${(flag as string).padEnd(25)} ${desc}${req}${engine}`);
    }
    console.log();
  }

  console.log("Engine flags:");
  console.log(`  ${"--until STAGE".padEnd(25)} Run stages up to STAGE`);
  console.log(`  ${"--resume".padEnd(25)} Resume from last checkpoint`);
  console.log(`  ${"--max-parallel N".padEnd(25)} Override max parallel`);
  console.log(`  ${"--trace-events".padEnd(25)} Save compacted raw pi event stream per stage`);
  console.log();

  console.log(`Stages (${stages.length}):`);
  for (const s of stages) {
    const t = s.type ?? "single";
    console.log(
      `  ${(s.id as string).padEnd(25)} [${t.padEnd(8)}] ${s.name ?? ""}`,
    );
  }
}

function hasPreviousRun(outputDir: string): boolean {
  const ckptDir = path.join(outputDir, ".youngflow", "checkpoints");
  if (!existsSync(ckptDir)) return false;
  return fg.globSync("*.done.yaml", { cwd: ckptDir }).length > 0;
}

// ---------------------------------------------------------------------------
// Flow-level logging (banner / summary — clean format, no prefix clutter)
// ---------------------------------------------------------------------------

let jsonMode = false;

function log(msg: string): void {
  logFlowMessage(msg, { stderr: !jsonMode });
}
