#!/usr/bin/env node

import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, "dist");

if (relative(projectRoot, dist) !== "dist" || dist === projectRoot) {
  throw new Error(`Refusing to clean an unsafe dist path: ${dist}`);
}

let rootReal = projectRoot;
try {
  rootReal = await realpath(projectRoot);
} catch {}

try {
  const stat = await lstat(dist);
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to clean symlinked dist directory: ${dist}`);
  }
  const distReal = await realpath(dist);
  if (relative(rootReal, distReal) !== "dist") {
    throw new Error(`Refusing to clean dist outside the project root: ${distReal}`);
  }
} catch (error) {
  if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
    process.exit(0);
  }
  throw error;
}

await rm(dist, { recursive: true, force: true });
