import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { hashDirectory, lstat } from "./skill-fs.js";
import {
  HELPER_SKILL_NAMES,
  fail,
  type HelperSkillBundle,
  type HelperSkillName,
} from "./skill-types.js";

export function defaultSkillBundleRoot(): string {
  return fileURLToPath(new URL("../../skills", import.meta.url));
}

function skillFrontmatterScalar(value: string, name: HelperSkillName): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {}
    fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${name} frontmatter contains an invalid quoted scalar.`);
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

function validateSkillFrontmatter(content: string, expectedName: HelperSkillName): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} must start with closed YAML frontmatter.`);
  }
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} contains an invalid frontmatter line.`);
    }
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} frontmatter may contain only name and description.`);
    }
    if (values.has(key)) {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} repeats frontmatter field ${key}.`);
    }
    values.set(key, skillFrontmatterScalar(line.slice(separator + 1), expectedName));
  }
  if (values.get("name") !== expectedName || !values.get("description")) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} must declare its exact name and a non-empty description.`);
  }
}

export function readHelperSkillBundle(bundleRoot = defaultSkillBundleRoot()): HelperSkillBundle {
  const root = path.resolve(bundleRoot);
  const rootStat = lstat(root);
  if (!rootStat?.isDirectory() || rootStat.isSymbolicLink()) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Skill bundle root is missing or unsafe: ${root}`);
  }

  const skills = HELPER_SKILL_NAMES.map(name => {
    const sourcePath = path.join(root, name);
    const manifest = path.join(sourcePath, "SKILL.md");
    const sourceStat = lstat(sourcePath);
    const manifestStat = lstat(manifest);
    if (!sourceStat?.isDirectory() || sourceStat.isSymbolicLink() || !manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Required Skill is missing or unsafe: ${name}`);
    }
    validateSkillFrontmatter(fs.readFileSync(manifest, "utf8"), name);
    return { name, sourcePath, hash: hashDirectory(sourcePath) };
  });

  const hash = createHash("sha256");
  for (const skill of skills) {
    hash.update(skill.name);
    hash.update("\0");
    hash.update(skill.hash);
    hash.update("\0");
  }
  return { root, hash: hash.digest("hex"), skills };
}
