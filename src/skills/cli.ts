import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  HELPER_SKILL_NAMES,
  defaultSkillBundleRoot,
  readHelperSkillBundle,
  type HelperSkillName,
} from "../helper/skills.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-meta.js";

export const SKILLS_CLI_SCHEMA = "hy-workflow.skills.v1" as const;
export const SKILLS_CLI_VERSION = 1 as const;

export type SkillFrontmatter = {
  name: HelperSkillName;
  description: string;
};

export type SkillsCliResult = {
  exitCode: number;
  stdout: string;
};

class SkillsCliError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SkillsCliError";
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new SkillsCliError("SKILL_FRONTMATTER_INVALID", "Skill frontmatter contains an invalid quoted scalar.");
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}

export function parseSkillFrontmatter(content: string, expectedName: HelperSkillName): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) {
    throw new SkillsCliError("SKILL_FRONTMATTER_INVALID", `Skill ${expectedName} must start with closed YAML frontmatter.`);
  }
  const values = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new SkillsCliError("SKILL_FRONTMATTER_INVALID", `Skill ${expectedName} contains an invalid frontmatter line.`);
    }
    const key = line.slice(0, separator).trim();
    if (key !== "name" && key !== "description") {
      throw new SkillsCliError("SKILL_FRONTMATTER_INVALID", `Skill ${expectedName} frontmatter may contain only name and description.`);
    }
    if (values.has(key)) {
      throw new SkillsCliError("SKILL_FRONTMATTER_INVALID", `Skill ${expectedName} repeats frontmatter field ${key}.`);
    }
    values.set(key, scalar(line.slice(separator + 1)));
  }
  const name = values.get("name");
  const description = values.get("description");
  if (name !== expectedName || !description) {
    throw new SkillsCliError("SKILL_FRONTMATTER_INVALID", `Skill ${expectedName} must declare its exact name and a non-empty description.`);
  }
  return { name: expectedName, description };
}

function skillName(value: string): HelperSkillName {
  if (!(HELPER_SKILL_NAMES as readonly string[]).includes(value)) {
    throw new SkillsCliError("SKILL_UNKNOWN", `Unknown bundled Skill: ${value}.`);
  }
  return value as HelperSkillName;
}

function safeRelativePath(value: string): string {
  if (!value || value.includes("\\") || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new SkillsCliError("SKILL_PATH_UNSAFE", "Skill paths must be non-empty relative POSIX paths.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new SkillsCliError("SKILL_PATH_UNSAFE", "Skill paths must stay inside the selected Skill.");
  }
  return normalized;
}

function errorResult(error: unknown): SkillsCliResult {
  const known = error instanceof SkillsCliError;
  const envelope = {
    schema: SKILLS_CLI_SCHEMA,
    version: SKILLS_CLI_VERSION,
    ok: false,
    error: {
      type: "skill_bundle",
      code: known ? error.code : "SKILL_BUNDLE_READ_FAILED",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
  return { exitCode: 1, stdout: `${JSON.stringify(envelope)}\n` };
}

export function skillsHelp(): string {
  return [
    "Usage:",
    "  hy-workflow skills list [--json]",
    "  hy-workflow skills read <name> [relative-path] [--json]",
    "",
    "Lists or reads the first-party Skill content shipped with this exact CLI package.",
  ].join("\n");
}

export function runSkillsCli(
  argv: string[],
  bundleRoot = defaultSkillBundleRoot(),
): SkillsCliResult {
  try {
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
      return { exitCode: 0, stdout: `${skillsHelp()}\n` };
    }
    const [command, ...rawArgs] = argv;
    const asJson = rawArgs.includes("--json");
    const args = rawArgs.filter(arg => arg !== "--json");
    const unknownOption = args.find(arg => arg.startsWith("-"));
    if (unknownOption) {
      throw new SkillsCliError("SKILL_OPTION_UNKNOWN", `Unknown skills option: ${unknownOption}.`);
    }

    const bundle = readHelperSkillBundle(bundleRoot);
    if (command === "list") {
      if (args.length) {
        throw new SkillsCliError("SKILL_ARGUMENT_INVALID", "skills list does not accept positional arguments.");
      }
      const skills = bundle.skills.map(entry => {
        const manifestPath = path.join(entry.sourcePath, "SKILL.md");
        const content = fs.readFileSync(manifestPath, "utf8");
        const frontmatter = parseSkillFrontmatter(content, entry.name);
        return {
          name: entry.name,
          description: frontmatter.description,
          path: `skills/${entry.name}/SKILL.md`,
          contentHash: sha256(content),
          bundleEntryHash: entry.hash,
        };
      });
      const envelope = {
        schema: SKILLS_CLI_SCHEMA,
        version: SKILLS_CLI_VERSION,
        ok: true,
        package: {
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          bundleHash: bundle.hash,
        },
        count: skills.length,
        skills,
      };
      return { exitCode: 0, stdout: `${JSON.stringify(envelope)}\n` };
    }

    if (command === "read") {
      if (args.length < 1 || args.length > 2) {
        throw new SkillsCliError("SKILL_ARGUMENT_INVALID", "skills read requires <name> and at most one relative path.");
      }
      const name = skillName(args[0]);
      const relative = safeRelativePath(args[1] ?? "SKILL.md");
      const entry = bundle.skills.find(candidate => candidate.name === name)!;
      const file = path.resolve(entry.sourcePath, ...relative.split("/"));
      const relativeToSkill = path.relative(entry.sourcePath, file);
      if (!relativeToSkill || relativeToSkill.startsWith("..") || path.isAbsolute(relativeToSkill)) {
        throw new SkillsCliError("SKILL_PATH_UNSAFE", "Skill path escaped the selected Skill.");
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(file);
      } catch {
        throw new SkillsCliError("SKILL_FILE_NOT_FOUND", `Bundled Skill file not found: ${name}/${relative}.`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new SkillsCliError("SKILL_FILE_INVALID", "Bundled Skill reads require a regular non-symlink file.");
      }
      const content = fs.readFileSync(file);
      if (!asJson) return { exitCode: 0, stdout: content.toString("utf8") };
      const envelope = {
        schema: SKILLS_CLI_SCHEMA,
        version: SKILLS_CLI_VERSION,
        ok: true,
        package: {
          name: PACKAGE_NAME,
          version: PACKAGE_VERSION,
          bundleHash: bundle.hash,
        },
        skill: name,
        path: relative,
        contentHash: sha256(content),
        content: content.toString("utf8"),
      };
      return { exitCode: 0, stdout: `${JSON.stringify(envelope)}\n` };
    }

    throw new SkillsCliError("SKILL_COMMAND_UNKNOWN", `Unknown skills command: ${command}.`);
  } catch (error) {
    return errorResult(error);
  }
}
