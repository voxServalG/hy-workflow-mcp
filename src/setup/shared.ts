import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { JsonObject } from "../config.js";
import { atomicWriteText } from "../runtime/user-paths.js";
import { SetupFailure, type ArtifactEvidence } from "./types.js";
import { planAgentsFile } from "./agents-rules.js";

const WORKFLOW_FILE = ".github/workflows/hy-workflow.yml";
const CONFIG_FILE = "hy-workflow.json";
export const AGENTS_FILE = "AGENTS.md";
export const SHARED_PROJECT_FILES = [CONFIG_FILE, WORKFLOW_FILE, AGENTS_FILE] as const;

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function assertSharedArtifactTarget(root: string, relative: string): string {
  const project = path.resolve(root);
  const target = path.resolve(project, relative);
  if (!inside(project, target)) {
    throw new SetupFailure("artifact_drift", "SETUP_PROJECT_PATH_UNSAFE", `${relative} escapes the project root.`, "Replace it with a normal project-relative path, then rerun setup.", { root: project, target });
  }
  let current = project;
  for (const segment of path.relative(project, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) {
        throw new SetupFailure("artifact_drift", "SETUP_PROJECT_PATH_UNSAFE", `${relative} traverses symbolic link ${current}.`, "Replace the symlink with a normal in-repository directory or file, then rerun setup.", { root: project, target, symlink: current });
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const canonicalRoot = fs.realpathSync(project);
  if (fs.existsSync(target) && !inside(canonicalRoot, fs.realpathSync(target))) {
    throw new SetupFailure("artifact_drift", "SETUP_PROJECT_PATH_UNSAFE", `${relative} resolves outside the project root.`, "Replace the path with a normal in-repository file, then rerun setup.", { root: canonicalRoot, target });
  }
  return target;
}

function templateText(): string {
  const template = new URL("../../templates/hy-workflow.yml", import.meta.url);
  return fs.readFileSync(template, "utf-8");
}

function changed(root: string, relative: string, next: string): boolean {
  const target = assertSharedArtifactTarget(root, relative);
  return !fs.existsSync(target) || fs.readFileSync(target, "utf-8") !== next;
}

function write(root: string, relative: string, next: string): void {
  const target = assertSharedArtifactTarget(root, relative);
  atomicWriteText(target, next, 0o644);
}

export function sharedArtifactPlan(root: string, config: JsonObject): Array<{ file: string; content: string }> {
  const values: Array<{ file: string; content: string }> = [
    { file: CONFIG_FILE, content: JSON.stringify(config, null, 2) + "\n" },
    { file: WORKFLOW_FILE, content: templateText() },
  ];
  const agents = planAgentsFile(root);
  if (agents.changed) values.push({ file: AGENTS_FILE, content: agents.nextContent });
  return values.filter(item => changed(root, item.file, item.content));
}

export function writeSharedArtifacts(
  root: string,
  config: JsonObject,
  dryRun = false,
  beforeWrite?: (file: string) => void,
  afterWrite?: (file: string) => void,
): string[] {
  const planned = sharedArtifactPlan(root, config);
  if (!dryRun) {
    for (const item of planned) {
      beforeWrite?.(item.file);
      write(root, item.file, item.content);
      afterWrite?.(item.file);
    }
  }
  return planned.map(item => item.file);
}

export function sharedArtifactEvidence(root: string): Record<string, ArtifactEvidence> {
  const evidence: Record<string, ArtifactEvidence> = {};
  for (const file of SHARED_PROJECT_FILES) {
    const target = assertSharedArtifactTarget(root, file);
    if (!fs.existsSync(target)) continue;
    const content = fs.readFileSync(target);
    evidence[file] = { sha256: createHash("sha256").update(content).digest("hex"), size: content.byteLength };
  }
  return evidence;
}

export function contentEvidence(content: string): ArtifactEvidence {
  const bytes = Buffer.from(content);
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
}
