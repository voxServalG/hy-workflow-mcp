import type { ContractFinding, ContractLintReport, ContractRule } from "./types.js";
import { checkArtifactContracts } from "./rules/artifacts.js";
import { checkErrorContracts } from "./rules/errors.js";
import { checkNpmContracts } from "./rules/npm.js";
import { checkOutputContracts } from "./rules/output.js";
import { checkSkillContracts } from "./rules/skills.js";
import { checkToolContracts } from "./rules/tools.js";
import { checkWorkflowContracts } from "./rules/workflow.js";

const RULES: ContractRule[] = [
  { name: "tools", run: checkToolContracts },
  { name: "errors", run: checkErrorContracts },
  { name: "output", run: checkOutputContracts },
  { name: "workflow", run: checkWorkflowContracts },
  { name: "artifacts", run: checkArtifactContracts },
  { name: "skills", run: checkSkillContracts },
  { name: "npm", run: checkNpmContracts },
];

export function runContractLint(root = process.cwd()): ContractLintReport {
  const findings: ContractFinding[] = [];
  for (const rule of RULES) {
    try {
      findings.push(...rule.run({ root }));
    } catch (error: any) {
      findings.push({ rule: rule.name, severity: "hard_fail", message: error?.message ?? String(error) });
    }
  }
  const counts = {
    hard_fail: findings.filter(finding => finding.severity === "hard_fail").length,
    amend_required: findings.filter(finding => finding.severity === "amend_required").length,
    warning: findings.filter(finding => finding.severity === "warning").length,
  };
  const status = counts.hard_fail > 0
    ? "hard_fail"
    : counts.amend_required > 0
      ? "amend_required"
      : counts.warning > 0
        ? "warning"
        : "passed";
  return { ok: counts.hard_fail === 0 && counts.amend_required === 0, status, counts, findings };
}

