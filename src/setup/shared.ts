import * as fs from "node:fs";
import * as path from "node:path";
import type { JsonObject } from "../config.js";

const WORKFLOW_FILE = ".github/workflows/hy-workflow.yml";
const CONFIG_FILE = "hy-workflow.json";
export const SHARED_PROJECT_FILES = [CONFIG_FILE, WORKFLOW_FILE] as const;

function templateText(): string {
  const template = new URL("../../templates/hy-workflow.yml", import.meta.url);
  return fs.readFileSync(template, "utf-8");
}

function changed(root: string, relative: string, next: string): boolean {
  const target = path.join(root, relative);
  return !fs.existsSync(target) || fs.readFileSync(target, "utf-8") !== next;
}

function write(root: string, relative: string, next: string): void {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, next, "utf-8");
}

export function sharedArtifactPlan(root: string, config: JsonObject): Array<{ file: string; content: string }> {
  const values = [
    { file: CONFIG_FILE, content: JSON.stringify(config, null, 2) + "\n" },
    { file: WORKFLOW_FILE, content: templateText() },
  ];
  return values.filter(item => changed(root, item.file, item.content));
}

export function writeSharedArtifacts(root: string, config: JsonObject, dryRun = false): string[] {
  const planned = sharedArtifactPlan(root, config);
  if (!dryRun) {
    for (const item of planned) write(root, item.file, item.content);
  }
  return planned.map(item => item.file);
}
