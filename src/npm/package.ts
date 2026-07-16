import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

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

export type NpmPackEntry = {
  filename?: string;
  integrity?: string;
  shasum?: string;
  files?: Array<{ path?: string; size?: number; mode?: number }>;
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

export function parseNpmPackEntries(report: unknown): NpmPackEntry[] {
  const values = Array.isArray(report)
    ? report
    : report !== null && typeof report === "object"
      ? Object.values(report as Record<string, unknown>)
      : [];
  return values.filter((entry): entry is NpmPackEntry => entry !== null && typeof entry === "object");
}

export function npmPackReport(root: string, dryRun = true, destination?: string): NpmPackEntry[] {
  const args = ["pack", ...(dryRun ? ["--dry-run"] : []), "--json"];
  if (destination) args.push("--pack-destination", path.resolve(destination));
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const raw = execFileSync(command, args, {
    cwd: root,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 180_000,
  });
  return parseNpmPackEntries(JSON.parse(raw));
}

export function npmPackDryRun(root: string): string[] {
  return parseNpmPackFiles(npmPackReport(root));
}
