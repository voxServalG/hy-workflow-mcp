import { CLI_COMMAND_NAMES, COMMAND_CONTRACTS } from "../../commands/catalog.js";
import { PHASES, VALID_TRANSITIONS } from "../../runtime/state-machine.js";
import { SKILL_CONTRACTS } from "../../skills/catalog.js";
import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const MERGE_RECOVERY_SOURCE_TOKENS = [
  "acquireMergeLock",
  "fetchRemoteBaseEvidence",
  "reconcileMerge",
  "executePrMerge",
  "checkoutDetached",
  "updateBranchRefCas",
  "pushForceWithLease",
  "syncBaseOid",
  "isAgentBranch",
  'state = "rebasing"',
  "already_integrated",
  'evidence: "git"',
  '"--no-tags"',
  "--force-with-lease=",
  "refs/remotes/origin/",
  "baseOid",
  "isAncestor",
] as const;

const MERGE_RECOVERY_DOC_TOKENS = [
  "fresh-fetch ancestry",
  "read-only Git fallback",
  "detached staging",
  "compare-and-swap",
] as const;

export function checkWorkflowContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const state = readText(context.root, "src/state.ts");
  const docs = readText(context.root, "docs/state-machine.md");
  const tick = String.fromCharCode(96);
  if (!state.includes("./runtime/state-machine.js")) {
    findings.push({ rule: "workflow", severity: "hard_fail", message: "src/state.ts must consume canonical runtime state-machine constants.", file: "src/state.ts" });
  }
  for (const phase of PHASES) {
    if (!docs.includes(tick + phase + tick)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: `Phase ${phase} is missing from docs/state-machine.md.`, file: "docs/state-machine.md" });
    }
  }
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    for (const to of targets) {
      if (!docs.includes(from) || !docs.includes(to)) {
        findings.push({ rule: "workflow", severity: "amend_required", message: `Transition ${from} -> ${to} is not clearly documented.`, file: "docs/state-machine.md" });
      }
    }
  }

  const cliPath = "src/cli/workflow.ts";
  const mainPath = "src/main.ts";
  const cli = readText(context.root, cliPath);
  const main = readText(context.root, mainPath);
  for (const command of CLI_COMMAND_NAMES) {
    if (!cli.includes(`"${command}"`)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: `Workflow CLI is missing public command ${command}.`, file: cliPath });
    }
  }
  for (const removed of ["ci", "chain", "hy_ci", "hy_chain"]) {
    if (CLI_COMMAND_NAMES.includes(removed as any)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: `${removed} must remain an internal stage rather than a public command.`, file: cliPath });
    }
  }
  if (!main.includes("runWorkflowCli") || main.includes("StdioServerTransport") || main.includes("server.connect(")) {
    findings.push({ rule: "workflow", severity: "hard_fail", message: "Public entrypoint must dispatch the CLI state machine and must not start MCP.", file: mainPath });
  }
  if (exists(context.root, "src/server.ts")) {
    findings.push({ rule: "workflow", severity: "hard_fail", message: "MCP server source must remain removed.", file: "src/server.ts" });
  }

  for (const contract of COMMAND_CONTRACTS) {
    if (!contract.phases.length || !contract.stages.length) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: `Command ${contract.command} has no phase/stage ownership.`, file: "src/commands/catalog.ts" });
    }
  }
  const skillText = new Map(SKILL_CONTRACTS.map(skill => [skill.name, readText(context.root, skill.path)]));
  for (const [skillName, tokens] of [
    ["hy-approve", ["explicit", "approve", "reject", "revise", "approve.before_approve", "approve.decision"]],
    ["hy-edit", ["edit.scope", "edit.implementation", "read-docs"]],
    ["hy-verify", ["verify.run", "verify.amendment", "exam-plan", "exam-submit", "amend-plan"]],
    ["hy-commit", ["commit.prepare", "commit.publish", "commit.ci"]],
    ["hy-merge", ["merge.reconcile", "merge.sync"]],
  ] as const) {
    const text = skillText.get(skillName) ?? "";
    for (const token of tokens) {
      if (!text.includes(token)) findings.push({ rule: "workflow", severity: "hard_fail", message: `${skillName} is missing workflow token ${token}.`, file: `skills/${skillName}/SKILL.md` });
    }
  }

  const mergeSource = [
    readText(context.root, "src/git.ts"),
    readText(context.root, "src/merge-recovery.ts"),
    readText(context.root, "src/tools/merge.ts"),
  ].join("\n");
  for (const token of MERGE_RECOVERY_SOURCE_TOKENS) {
    if (!mergeSource.includes(token)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: `Merge recovery implementation omits ${token}.`, file: "src/git.ts" });
    }
  }
  const mergeMutations = mergeSource.match(/\[\s*"pr"\s*,\s*"merge"/g) ?? [];
  if (mergeMutations.length !== 1) {
    findings.push({ rule: "workflow", severity: "hard_fail", message: `Merge recovery must have exactly one gh pr merge mutation site; found ${mergeMutations.length}.`, file: "src/git.ts" });
  }
  const mergeDocs = [
    readText(context.root, "docs/state-machine.md"),
    readText(context.root, "docs/tools.md"),
    readText(context.root, "docs/architecture.md"),
  ].join("\n");
  for (const token of MERGE_RECOVERY_DOC_TOKENS) {
    if (!mergeDocs.includes(token)) {
      findings.push({ rule: "workflow", severity: "amend_required", message: `Merge recovery documentation omits ${token}.`, file: "docs/state-machine.md" });
    }
  }

  const commit = readText(context.root, "src/tools/commit.ts");
  for (const token of ['stage: "commit.ci"', "noChecks", "noEffectiveChecks", "CI_CHECKS_REQUIRED"]) {
    if (!commit.includes(token)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: `Internal commit.ci must fail closed without real effective checks: missing ${token}.`, file: "src/tools/commit.ts" });
    }
  }
  return findings;
}
