import {
  PHASES,
  WORKFLOW_STAGES,
  type Phase,
  type WorkflowStage,
} from "../runtime/state-machine.js";
import type { WorkflowCliCommandName } from "../commands/catalog.js";

export type SkillContract = {
  name: `hy-${string}`;
  path: `skills/${string}/SKILL.md`;
  commands: readonly WorkflowCliCommandName[];
  phases: readonly Phase[];
  stages: readonly WorkflowStage[];
  requiresCliAuthority: true;
  requiresExactArgv: true;
  forbidsPrivateStateAccess: true;
};

const skill = (
  name: SkillContract["name"],
  commands: readonly WorkflowCliCommandName[],
  phases: readonly Phase[],
  stages: readonly WorkflowStage[],
): SkillContract => ({
  name,
  path: `skills/${name}/SKILL.md`,
  commands,
  phases,
  stages,
  requiresCliAuthority: true,
  requiresExactArgv: true,
  forbidsPrivateStateAccess: true,
});

export const SKILL_CONTRACTS = [
  skill("hy-init", ["init"], ["init"], ["init.ready"]),
  skill("hy-status", ["status"], PHASES, WORKFLOW_STAGES),
  skill("hy-read-docs", ["read-docs"], ["plan", "approve", "edit"], ["plan.before_plan", "approve.before_approve", "edit.after_edit"]),
  skill("hy-plan", ["plan"], ["plan"], ["plan.compose", "plan.review"]),
  skill("hy-approve", ["approve"], ["approve"], ["approve.before_approve", "approve.decision"]),
  skill("hy-branch", ["branch"], ["branch"], ["branch.create"]),
  skill("hy-edit", ["edit"], ["edit"], ["edit.scope", "edit.implementation"]),
  skill("hy-sync-docs", ["sync-docs"], ["edit"], ["edit.after_edit", "edit.sync_docs"]),
  skill("hy-verify", ["verify", "exam-plan", "exam-submit", "amend-plan"], ["edit", "verify"], ["edit.sync_docs", "verify.run", "verify.amendment"]),
  skill("hy-commit", ["commit"], ["commit"], ["commit.prepare", "commit.publish", "commit.ci"]),
  skill("hy-merge", ["merge"], ["merge"], ["merge.reconcile", "merge.sync"]),
  skill("hy-reset", ["reset"], PHASES, WORKFLOW_STAGES),
] as const satisfies readonly SkillContract[];

export const SKILL_NAMES = SKILL_CONTRACTS.map(contract => contract.name);
export const SKILL_PATHS = SKILL_CONTRACTS.map(contract => contract.path);
