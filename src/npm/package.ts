import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export type PackageJson = {
  name?: string;
  main?: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
};

export function readPackageJson(root: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
}

export function npmPackDryRun(root: string): string[] {
  const raw = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
  const parsed = JSON.parse(raw);
  const files = parsed?.[0]?.files ?? [];
  return files.map((file: { path: string }) => file.path).filter(Boolean).sort();
}

