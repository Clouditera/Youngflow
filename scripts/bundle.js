#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const outDir = path.join(root, "bundle");

mkdirSync(outDir, { recursive: true });

const entryPath = path.join(outDir, "entry.mjs");
writeFileSync(entryPath, "import { main } from '../dist/cli.js';\nmain();\n");

execFileSync(path.join(root, "node_modules", ".bin", "esbuild"), [
  entryPath,
  "--bundle",
  "--platform=node",
  "--target=node20",
  "--format=cjs",
  `--outfile=${path.join(outDir, "cli.cjs")}`,
], { stdio: "inherit" });

cpSync(path.join(root, "dist", "flow.schema.yaml"), path.join(outDir, "flow.schema.yaml"));

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8"));
const bundlePkg = {
  name: pkg.name,
  version: pkg.version,
  description: pkg.description,
  type: "commonjs",
  bin: "cli.cjs",
  pkg: {
    assets: ["flow.schema.yaml", "package.json"],
    targets: pkg.pkg?.targets ?? [],
    outputPath: pkg.pkg?.outputPath ?? "release",
  },
};
writeFileSync(path.join(outDir, "package.json"), `${JSON.stringify(bundlePkg, null, 2)}\n`);

console.log(`Bundle written to ${outDir}`);
