import { COMMAND_NAMES } from "../../commands/catalog.js";
import { SKILL_CONTRACTS } from "../../skills/catalog.js";
import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

export function checkSkillContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const removedPublicTools = ["hy_ci", "hy_chain"] as const;
  for (const skill of SKILL_CONTRACTS) {
    if (!exists(context.root, skill.path)) {
      findings.push({ rule: "skills", severity: "hard_fail", message: "Skill file is missing: " + skill.path + ".", file: skill.path });
      continue;
    }
    const text = readText(context.root, skill.path);
    for (const removed of removedPublicTools) {
      if (skill.tools.includes(removed) || text.includes(removed)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill must not expose removed public tool ${removed}; use internal commit.ci or merge.sync guidance.`, file: skill.path });
      }
    }
    for (const tool of skill.tools) {
      if (!COMMAND_NAMES.includes(tool)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: "Skill references unknown tool " + tool + ".", file: skill.path });
      }
      if (!text.includes(tool)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: "Skill does not document required tool " + tool + ".", file: skill.path });
      }
    }
    for (const command of COMMAND_NAMES) {
      if (!skill.tools.includes(command)) {
        findings.push({ rule: "skills", severity: "hard_fail", message: `Skill tool catalog must be derived from COMMAND_NAMES and include ${command}.`, file: skill.path });
      }
    }
    for (const token of ["workflow order", "output", "error", "recovery", "approve"]) {
      if (!text.toLowerCase().includes(token)) {
        findings.push({ rule: "skills", severity: "amend_required", message: "Skill is missing " + token + " guidance.", file: skill.path });
      }
    }
  }
  return findings;
}
