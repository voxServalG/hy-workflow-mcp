import { TOOL_RECOVERY_STRATEGIES } from "../../output/control.js";
import { exists, readText, walkFiles } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const KERNEL_FIELDS = [
  "phase",
  "stage",
  "status",
  "nextAction",
  "control",
  "userAction",
  "data",
  "error",
  "checks",
  "findings",
] as const;

const CLI_TOKENS = [
  'WORKFLOW_CLI_SCHEMA = "hy-workflow.cli.v1"',
  "WORKFLOW_CLI_VERSION = 1",
  "stableJsonStringify",
  "workflowCommandArgv",
  "phase:",
  "stage:",
  "status:",
  "route: {",
  "nextPhase:",
  "action:",
  "allowed:",
  "blocked:",
  "control:",
  "userAction:",
  "recovery",
  "argv:",
  "factFields(result)",
  "errorWithoutHint",
  "command: _shellCommand",
  "prompt: _prompt",
  "instruction: _instruction",
] as const;

const CI_FAIL_CLOSED_SOURCE_TOKENS = [
  'commitResult("commit"',
  "CI_CHECKS_REQUIRED",
  "noChecks",
  "noEffectiveChecks",
  "requires_user: true",
  "stop_here: true",
  'blockedTools: ["hy_merge"]',
  'stage: "commit.ci"',
] as const;

function missing(findings: ContractFinding[], tokens: readonly string[], text: string, file: string, label: string): void {
  for (const token of tokens) {
    if (!text.includes(token)) findings.push({ rule: "output", severity: "hard_fail", message: `${label} omits ${token}.`, file });
  }
}

export function checkOutputContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  for (const file of ["src/output/contract.ts", "src/output/envelope.ts", "src/output/control.ts", "src/cli/workflow.ts"]) {
    if (!exists(context.root, file)) findings.push({ rule: "output", severity: "hard_fail", message: `Required output module is missing: ${file}.`, file });
  }
  if (findings.length) return findings;

  const contract = readText(context.root, "src/output/contract.ts");
  const envelope = readText(context.root, "src/output/envelope.ts");
  const control = readText(context.root, "src/output/control.ts");
  const base = readText(context.root, "src/tools/_base.ts");
  const cliPath = "src/cli/workflow.ts";
  const cli = readText(context.root, cliPath);

  if (!base.includes("../output/envelope.js")) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Kernel tool helpers must delegate to the canonical envelope.", file: "src/tools/_base.ts" });
  }
  missing(findings, KERNEL_FIELDS, contract, "src/output/contract.ts", "Kernel field catalog");
  missing(findings, KERNEL_FIELDS, envelope, "src/output/envelope.ts", "Kernel typed envelope");
  missing(findings, TOOL_RECOVERY_STRATEGIES, control, "src/output/control.ts", "Kernel recovery strategy catalog");
  for (const token of ['| "approval"', 'kind: "review_failure"', 'approval: "approval_required"']) {
    if (!control.includes(token)) findings.push({ rule: "output", severity: "hard_fail", message: `Kernel approval separation is missing ${token}.`, file: "src/output/control.ts" });
  }

  missing(findings, CLI_TOKENS, cli, cliPath, "Public CLI envelope");
  for (const field of ["display", "summary", "hint"]) {
    if (!cli.includes(`"${field}"`)) {
      findings.push({ rule: "output", severity: "hard_fail", message: `CLI projection must explicitly suppress kernel prose field ${field}.`, file: cliPath });
    }
  }
  if (!cli.includes('stdout: `${JSON.stringify(envelope)}\\n`')) {
    findings.push({ rule: "output", severity: "hard_fail", message: "Workflow CLI must emit exactly one compact JSON document.", file: cliPath });
  }

  const recoveryEmitterFiles = [
    "src/bootstrap.ts",
    "src/config.ts",
    ...walkFiles(context.root, "src/tools", file => file.endsWith(".ts")),
  ];
  const recoveryObjectPattern = /\brecovery:\s*(?:ok\s*\?\s*undefined\s*:\s*)?\{/g;
  for (const file of recoveryEmitterFiles) {
    const source = readText(context.root, file);
    for (const match of source.matchAll(recoveryObjectPattern)) {
      const snippet = source.slice(match.index, match.index + 240);
      if (!snippet.includes("strategy:")) {
        findings.push({ rule: "output", severity: "hard_fail", message: "Kernel recovery object omits the strategy discriminator.", file });
      }
    }
  }

  const commit = readText(context.root, "src/tools/commit.ts");
  const start = commit.indexOf("if (ciResult.noChecks || ciResult.noEffectiveChecks)");
  const end = start < 0 ? -1 : commit.indexOf("if (!ciResult.allGreen)", start);
  const block = start < 0 ? "" : commit.slice(start, end < 0 ? undefined : end);
  missing(findings, CI_FAIL_CLOSED_SOURCE_TOKENS, block, "src/tools/commit.ts", "CI missing-check branch");
  return findings;
}
