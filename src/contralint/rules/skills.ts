import { CLI_COMMAND_NAMES } from "../../commands/catalog.js";
import { HELPER_SKILL_NAMES, type HelperSkillName } from "../../helper/skills.js";
import { PHASES, WORKFLOW_STAGES } from "../../runtime/state-machine.js";
import { SKILL_CONTRACTS } from "../../skills/catalog.js";
import { parseSkillFrontmatter } from "../../skills/cli.js";
import { exists, readText, walkFiles } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

export function checkSkillContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const actualPaths = walkFiles(context.root, "skills", file => /^skills\/[^/]+\/SKILL\.md$/.test(file));
  const expectedPaths = sorted(SKILL_CONTRACTS.map(skill => skill.path));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
    findings.push({
      rule: "skills",
      severity: "hard_fail",
      message: "Packaged Skill tree must match the 12-entry canonical catalog exactly.",
      file: "skills",
      detail: { expected: expectedPaths, actual: actualPaths },
    });
  }
  if (SKILL_CONTRACTS.length !== 12) {
    findings.push({ rule: "skills", severity: "hard_fail", message: "Skill catalog must contain exactly 12 stage Skills.", file: "src/skills/catalog.ts" });
  }
  const catalogNames = sorted(SKILL_CONTRACTS.map(skill => skill.name));
  if (JSON.stringify(catalogNames) !== JSON.stringify(sorted(HELPER_SKILL_NAMES))) {
    findings.push({ rule: "skills", severity: "hard_fail", message: "Skill ownership catalog and helper installation catalog must match exactly.", file: "src/skills/catalog.ts", detail: { catalogNames, helperNames: sorted(HELPER_SKILL_NAMES) } });
  }

  const ownedCommands: string[] = [];
  for (const skill of SKILL_CONTRACTS) {
    if (!exists(context.root, skill.path)) continue;
    const text = readText(context.root, skill.path);
    try {
      parseSkillFrontmatter(text, skill.name as HelperSkillName);
    } catch (error) {
      findings.push({
        rule: "skills",
        severity: "hard_fail",
        message: `Skill frontmatter must contain only the exact name and a non-empty description for ${skill.name}.`,
        file: skill.path,
        detail: { cause: error instanceof Error ? error.message : String(error) },
      });
    }
    if (skill.name === "hy-status") {
      for (const token of ["Shared CLI control contract", "sole authority", "private state files", "route", "argv"]) {
        if (!text.includes(token)) {
          findings.push({ rule: "skills", severity: "hard_fail", message: `Shared status Skill is missing CLI-authority token ${token}.`, file: skill.path });
        }
      }
    } else {
      const prerequisite = "[`../hy-status/SKILL.md`](../hy-status/SKILL.md)";
      if (!text.includes(prerequisite)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: "Stage Skill must declare hy-status as its shared CLI control prerequisite.", file: skill.path });
      }
      if (text.includes("## CLI control contract") || text.includes("## Shared CLI control contract")) {
        findings.push({ rule: "skills", severity: "hard_fail", message: "Only hy-status may define the shared CLI control contract.", file: skill.path });
      }
    }
    for (const command of skill.commands) {
      ownedCommands.push(command);
      if (!CLI_COMMAND_NAMES.includes(command)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill owns unknown CLI command ${command}.`, file: skill.path });
      }
      if (!text.includes(`hy-workflow ${command}`)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill must document the exact CLI command hy-workflow ${command}.`, file: skill.path });
      }
    }
    for (const phase of skill.phases) {
      if (!(PHASES as readonly string[]).includes(phase)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill owns unknown phase ${phase}.`, file: "src/skills/catalog.ts" });
      }
    }
    for (const stage of skill.stages) {
      if (!(WORKFLOW_STAGES as readonly string[]).includes(stage)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill owns unknown stage ${stage}.`, file: "src/skills/catalog.ts" });
      }
    }
    for (const legacyField of ["allowedTools", "nextAction", "display", "summary", "hint"]) {
      if (text.includes(legacyField)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill must consume the CLI route/data envelope instead of removed agent-prose field ${legacyField}.`, file: skill.path });
      }
    }
    for (const removed of ["hy_ci", "hy_chain"]) {
      if (text.includes(removed)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `${removed} is not a public CLI command; use commit.ci or merge.sync.`, file: skill.path });
      }
    }
    if (!skill.requiresCliAuthority || !skill.requiresExactArgv || !skill.forbidsPrivateStateAccess) {
      findings.push({ rule: "skills", severity: "hard_fail", message: "Every Skill must require CLI authority, exact argv, and the private-state boundary.", file: "src/skills/catalog.ts" });
    }
  }

  if (JSON.stringify(sorted(ownedCommands)) !== JSON.stringify(sorted(CLI_COMMAND_NAMES))) {
    findings.push({
      rule: "skills",
      severity: "hard_fail",
      message: "The 12 Skills must partition the 15 public CLI commands exactly once.",
      file: "src/skills/catalog.ts",
      detail: { expected: sorted(CLI_COMMAND_NAMES), actual: sorted(ownedCommands) },
    });
  }
  return findings;
}
