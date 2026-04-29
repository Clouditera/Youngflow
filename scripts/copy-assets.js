#!/usr/bin/env node
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const distDir = path.join(root, "dist");
mkdirSync(distDir, { recursive: true });

copyFileSync(
  path.join(root, "src", "flow.schema.yaml"),
  path.join(distDir, "flow.schema.yaml"),
);
