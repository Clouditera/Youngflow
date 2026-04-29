#!/usr/bin/env node
import { rmSync, mkdirSync, copyFileSync, existsSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const releaseDir = path.join(root, "release");
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

execFileSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  [
    "--no-install",
    "pkg",
    ".",
    "--targets",
    targets.join(","),
    "--out-path",
    releaseDir,
  ],
  { stdio: "inherit" },
);

if (targets.length === 1) {
  const target = targets[0];
  const isWindows = target.includes("win");
  const from = path.join(releaseDir, isWindows ? "youngflow.exe" : "youngflow");
  const to = path.join(releaseDir, binaryNameForTarget(target));
  if (existsSync(from) && from !== to) renameSync(from, to);
}

console.log(`\nBinaries written to ${releaseDir}`);

function binaryNameForTarget(target) {
  const suffix = target.replace(/^node\d+-/, "");
  return `youngflow-${suffix}${target.includes("win") ? ".exe" : ""}`;
}
