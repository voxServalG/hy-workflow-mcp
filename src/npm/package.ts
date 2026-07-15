import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

export type PackageJson = {
  name?: string;
  version?: string;
  main?: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
  repository?: { type?: string; url?: string } | string;
  publishConfig?: { access?: string };
  engines?: { node?: string };
};

export function readPackageJson(root: string): PackageJson {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
}

export function parseNpmPackFiles(report: unknown): string[] {
  const entries = Array.isArray(report)
    ? report
    : report !== null && typeof report === "object"
      ? Object.values(report as Record<string, unknown>)
      : [];

  return entries.flatMap(entry => {
    if (entry === null || typeof entry !== "object") return [];
    const files = (entry as { files?: unknown }).files;
    if (!Array.isArray(files)) return [];

    return files.flatMap(file => {
      if (file === null || typeof file !== "object") return [];
      const filePath = (file as { path?: unknown }).path;
      return typeof filePath === "string" && filePath.length > 0 ? [filePath] : [];
    });
  }).sort();
}

export function npmPackDryRun(root: string): string[] {
  const raw = execSync("npm pack --dry-run --json", { cwd: root, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
  return parseNpmPackFiles(JSON.parse(raw));
}
