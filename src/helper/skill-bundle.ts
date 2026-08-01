import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isScalar, parseDocument } from "yaml";
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

function validateSkillFrontmatter(content: string, expectedName: HelperSkillName): void {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} must start with closed YAML frontmatter.`);
  }

  const document = parseDocument(match[1], {
    customTags: [],
    merge: false,
    prettyErrors: false,
    resolveKnownTags: false,
    schema: "core",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length || document.warnings.length || !isMap(document.contents)
    || document.contents.anchor !== undefined || document.contents.tag !== undefined) {
    fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} contains invalid YAML frontmatter.`);
  }

  const values = new Map<string, string>();
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string"
      || pair.key.anchor !== undefined || pair.key.tag !== undefined
      || !isScalar(pair.value) || typeof pair.value.value !== "string"
      || pair.value.anchor !== undefined || pair.value.tag !== undefined) {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} frontmatter fields must be untagged string scalars.`);
    }
    const key = pair.key.value;
    if (key !== "name" && key !== "description") {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} frontmatter may contain only name and description.`);
    }
    if (values.has(key)) {
      fail("HELPER_SKILL_BUNDLE_INVALID", `Skill ${expectedName} repeats frontmatter field ${key}.`);
    }
    values.set(key, pair.value.value);
  }
  if (values.get("name") !== expectedName || !values.get("description")?.trim()) {
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
