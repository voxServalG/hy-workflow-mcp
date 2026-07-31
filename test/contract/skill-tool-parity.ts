import { readdirSync, readFileSync } from "node:fs";
import { CLI_COMMAND_NAMES } from "../../src/commands/catalog.js";
import { HELPER_SKILL_NAMES } from "../../src/helper/skills.js";
import { PHASES, WORKFLOW_STAGES } from "../../src/runtime/state-machine.js";
import { SKILL_CONTRACTS } from "../../src/skills/catalog.js";
import { parseSkillFrontmatter } from "../../src/skills/cli.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const actualPaths = readdirSync("skills", { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => `skills/${entry.name}/SKILL.md`)
  .filter(path => {
    try { readFileSync(path, "utf-8"); return true; } catch { return false; }
  })
  .sort();
const expectedPaths = SKILL_CONTRACTS.map(skill => skill.path).sort();
assert(SKILL_CONTRACTS.length === 12, "Skill catalog must contain exactly 12 stage Skills");
assert(JSON.stringify(actualPaths) === JSON.stringify(expectedPaths), "skills/*/SKILL.md must exactly match the canonical Skill catalog");
assert(
  JSON.stringify(SKILL_CONTRACTS.map(skill => skill.name).sort()) === JSON.stringify([...HELPER_SKILL_NAMES].sort()),
  "Skill ownership catalog and helper installation catalog must match exactly",
);

const ownedCommands: string[] = [];
for (const skill of SKILL_CONTRACTS) {
  const text = readFileSync(skill.path, "utf-8");
  parseSkillFrontmatter(text, skill.name);
  if (skill.name === "hy-status") {
    for (const token of ["Shared CLI control contract", "sole authority", "private state files", "route", "argv"]) {
      assert(text.includes(token), `${skill.path} is missing shared CLI authority token ${token}`);
    }
  } else {
    assert(
      text.includes("[`../hy-status/SKILL.md`](../hy-status/SKILL.md)"),
      `${skill.path} must declare hy-status as its shared CLI control prerequisite`,
    );
    assert(!text.includes("## CLI control contract") && !text.includes("## Shared CLI control contract"), `${skill.path} must not duplicate the shared CLI control contract`);
  }
  for (const command of skill.commands) {
    ownedCommands.push(command);
    assert(CLI_COMMAND_NAMES.includes(command), `${skill.path} owns unknown command ${command}`);
    assert(text.includes(`hy-workflow ${command}`), `${skill.path} must document exact command hy-workflow ${command}`);
  }
  for (const phase of skill.phases) assert((PHASES as readonly string[]).includes(phase), `${skill.path} owns unknown phase ${phase}`);
  for (const stage of skill.stages) {
    assert((WORKFLOW_STAGES as readonly string[]).includes(stage), `${skill.path} owns unknown stage ${stage}`);
  }
  for (const forbidden of ["allowedTools", "nextAction", "display", "summary", "hint", "hy_ci", "hy_chain"]) {
    assert(!text.includes(forbidden), `${skill.path} contains removed MCP/prose contract ${forbidden}`);
  }
  assert(skill.requiresCliAuthority && skill.requiresExactArgv && skill.forbidsPrivateStateAccess, `${skill.path} must bind all CLI authority requirements`);
}

const scaleTokens = {
  small: ["every change", "single-module", "deterministic", "isolated", "static", "type", "unit", "pure contract"],
  medium: ["modules", "processes", "file system", "local database", "serialization", "schema", "public API", "CLI", "configuration", "concurrency", "recovery state"],
  large: ["installation", "upgrade", "packaging", "release", "CI", "cross-platform", "external service", "security boundary", "irreversible compatibility", "historical major incident"],
};
for (const file of [
  "skills/hy-init/SKILL.md",
  "skills/hy-plan/SKILL.md",
  "skills/hy-verify/SKILL.md",
]) {
  const text = readFileSync(file, "utf8");
  for (const [scale, tokens] of Object.entries(scaleTokens)) {
    for (const token of tokens) {
      assert(
        text.toLowerCase().includes(token.toLowerCase()),
        `${file} omits mandatory ${scale} trigger: ${token}`,
      );
    }
  }
}

assert(
  JSON.stringify(ownedCommands.sort()) === JSON.stringify([...CLI_COMMAND_NAMES].sort()),
  "12 Skills must partition the 15 public CLI commands exactly once",
);
console.log("skill-tool-parity: exact 12-Skill package, stage ownership, CLI authority, and command partition pass");
