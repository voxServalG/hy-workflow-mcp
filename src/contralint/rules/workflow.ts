import { PHASES, VALID_TRANSITIONS } from "../../runtime/state-machine.js";
import { readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const DOCUMENT_GATE_SEQUENCE = [
  "hy_status",
  "hy_read_docs(before_plan)",
  "hy_plan",
  "hy_read_docs(before_approve)",
  "hy_approve",
  "hy_branch",
  "hy_edit",
  "hy_read_docs(after_edit)",
  "hy_sync_docs",
  "hy_verify",
  "hy_commit",
  "hy_merge",
];

const DOCUMENT_GATE_CONTRACT_FILES = [
  "AGENTS.md",
  "src/server.ts",
  "docs/state-machine.md",
  "docs/skills/core/SKILL.md",
];

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

function containsOrderedTokens(text: string, tokens: string[]): boolean {
  let cursor = 0;
  for (const token of tokens) {
    const index = text.indexOf(token, cursor);
    if (index < 0) return false;
    cursor = index + token.length;
  }
  return true;
}

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
      findings.push({ rule: "workflow", severity: "hard_fail", message: "Phase " + phase + " is missing from docs/state-machine.md.", file: "docs/state-machine.md" });
    }
  }
  for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
    for (const to of targets) {
      if (!docs.includes(from) || !docs.includes(to)) {
        findings.push({ rule: "workflow", severity: "amend_required", message: "Transition " + from + " -> " + to + " is not clearly documented.", file: "docs/state-machine.md" });
      }
    }
  }
  for (const file of DOCUMENT_GATE_CONTRACT_FILES) {
    const text = readText(context.root, file);
    if (!containsOrderedTokens(text, DOCUMENT_GATE_SEQUENCE)) {
      findings.push({
        rule: "workflow",
        severity: "hard_fail",
        message: "Agent contract must preserve the complete hy_status -> docs/plan/approve -> branch/edit/docs/verify -> commit/merge order.",
        file,
        detail: { expected: DOCUMENT_GATE_SEQUENCE },
      });
    }
  }
  const mergeSource = [
    readText(context.root, "src/git.ts"),
    readText(context.root, "src/merge-recovery.ts"),
    readText(context.root, "src/tools/merge.ts"),
  ].join("\n");
  for (const token of MERGE_RECOVERY_SOURCE_TOKENS) {
    if (!mergeSource.includes(token)) {
      findings.push({
        rule: "workflow",
        severity: "hard_fail",
        message: `Merge recovery implementation omits ${token}.`,
        file: "src/git.ts",
      });
    }
  }
  const mergeMutations = mergeSource.match(/\[\s*"pr"\s*,\s*"merge"/g) ?? [];
  if (mergeMutations.length !== 1) {
    findings.push({
      rule: "workflow",
      severity: "hard_fail",
      message: `Merge recovery must have exactly one gh pr merge mutation site; found ${mergeMutations.length}.`,
      file: "src/git.ts",
    });
  }
  const mergeDocs = [
    readText(context.root, "docs/state-machine.md"),
    readText(context.root, "docs/tools.md"),
    readText(context.root, "docs/architecture.md"),
  ].join("\n");
  for (const token of MERGE_RECOVERY_DOC_TOKENS) {
    if (!mergeDocs.includes(token)) {
      findings.push({
        rule: "workflow",
        severity: "amend_required",
        message: `Merge recovery documentation omits ${token}.`,
        file: "docs/state-machine.md",
      });
    }
  }
  const ci = readText(context.root, "templates/hy-workflow.yml");
  for (const token of [
    "No supported project ecosystem detected",
    "No native verification command detected",
    "ci.commands must be a non-empty string array",
    "hy-workflow.lint.v1",
    "report.counts.docs <= 0",
    "report.ok !== true",
    "report.counts.errors > 0",
  ]) {
    if (!ci.includes(token)) {
      findings.push({ rule: "workflow", severity: "hard_fail", message: "Required CI must fail closed: missing " + token + ".", file: "templates/hy-workflow.yml" });
    }
  }
  return findings;
}
