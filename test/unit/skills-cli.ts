import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { HELPER_SKILL_NAMES } from "../../src/helper/skills.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/package-meta.js";
import {
  SKILLS_CLI_SCHEMA,
  SKILLS_CLI_VERSION,
  runSkillsCli,
} from "../../src/skills/cli.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parse(stdout: string): any {
  return JSON.parse(stdout);
}

function expectError(argv: string[], code: string): void {
  const result = runSkillsCli(argv, bundleRoot);
  const envelope = parse(result.stdout);
  assert(result.exitCode === 1 && envelope.ok === false, `${argv.join(" ")} must fail as a structured envelope`);
  assert(envelope.error?.code === code, `${argv.join(" ")} must return ${code}, got ${envelope.error?.code}`);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundleRoot = path.join(repositoryRoot, "skills");

const listed = runSkillsCli(["list", "--json"], bundleRoot);
const listEnvelope = parse(listed.stdout);
assert(listed.exitCode === 0 && listEnvelope.ok === true, "skills list must succeed");
assert(listEnvelope.schema === SKILLS_CLI_SCHEMA && listEnvelope.version === SKILLS_CLI_VERSION, "skills list must use the versioned envelope");
assert(listEnvelope.package.name === PACKAGE_NAME && listEnvelope.package.version === PACKAGE_VERSION, "skills list must identify the exact running package");
assert(/^[a-f0-9]{64}$/.test(listEnvelope.package.bundleHash), "skills list must expose the bundle hash");
assert(listEnvelope.count === 12, "skills list must expose exactly twelve stage Skills");
assert(
  listEnvelope.skills.map((skill: any) => skill.name).join(",") === HELPER_SKILL_NAMES.join(","),
  "skills list must preserve canonical workflow order",
);
for (const skill of listEnvelope.skills) {
  assert(typeof skill.description === "string" && skill.description.length > 20, `${skill.name} must expose a useful trigger description`);
  assert(skill.path === `skills/${skill.name}/SKILL.md`, `${skill.name} must expose its packaged path`);
  assert(/^[a-f0-9]{64}$/.test(skill.contentHash) && /^[a-f0-9]{64}$/.test(skill.bundleEntryHash), `${skill.name} must expose stable hashes`);
}

const expectedStatus = fs.readFileSync(path.join(bundleRoot, "hy-status", "SKILL.md"), "utf8");
const raw = runSkillsCli(["read", "hy-status"], bundleRoot);
assert(raw.exitCode === 0 && raw.stdout === expectedStatus, "raw Skill read must be byte-identical UTF-8 content");

const jsonRead = runSkillsCli(["read", "hy-status", "SKILL.md", "--json"], bundleRoot);
const readEnvelope = parse(jsonRead.stdout);
assert(jsonRead.exitCode === 0 && readEnvelope.ok === true, "JSON Skill read must succeed");
assert(readEnvelope.skill === "hy-status" && readEnvelope.path === "SKILL.md", "JSON Skill read must bind the exact target");
assert(readEnvelope.content === expectedStatus && /^[a-f0-9]{64}$/.test(readEnvelope.contentHash), "JSON Skill read must include exact content and hash");
assert(readEnvelope.package.bundleHash === listEnvelope.package.bundleHash, "list and read must identify one bundle");

expectError(["unknown"], "SKILL_COMMAND_UNKNOWN");
expectError(["list", "hy-status"], "SKILL_ARGUMENT_INVALID");
expectError(["read"], "SKILL_ARGUMENT_INVALID");
expectError(["read", "not-a-skill"], "SKILL_UNKNOWN");
expectError(["read", "hy-status", "../hy-plan/SKILL.md"], "SKILL_PATH_UNSAFE");
expectError(["read", "hy-status", "..\\hy-plan\\SKILL.md"], "SKILL_PATH_UNSAFE");
expectError(["read", "hy-status", "--unknown"], "SKILL_OPTION_UNKNOWN");
expectError(["read", "hy-status", "missing.md"], "SKILL_FILE_NOT_FOUND");

console.log("skills-cli: canonical list, exact raw/JSON reads, package hashes, and traversal-safe failures pass");
