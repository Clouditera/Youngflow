#!/usr/bin/env node
import { rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const releaseDir = path.join(root, "release");
const pkgBin = path.join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js");
const defaultTargets = [
  "node20-linux-x64",
  "node20-macos-x64",
  "node20-macos-arm64",
  "node20-win-x64",
];
const targets = (process.env.PKG_TARGETS ?? "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);
if (targets.length === 0) targets.push(...defaultTargets);

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });

for (const target of targets) {
  const output = path.join(releaseDir, binaryNameForTarget(target));
  execFileSync(
    process.execPath,
    [pkgBin, ".", "--targets", target, "--output", output],
    { stdio: "inherit" },
  );
}

console.log(`\nBinaries written to ${releaseDir}`);

function binaryNameForTarget(target) {
  const suffix = target.replace(/^node\d+-/, "");
  return `youngflow-${suffix}${target.includes("win") ? ".exe" : ""}`;
}
