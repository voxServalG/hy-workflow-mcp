import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

export function checkSetupContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  for (const legacy of ["setup", "setup.ps1"]) {
    if (exists(context.root, legacy)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Legacy platform setup script must be removed: ${legacy}.`, file: legacy });
    }
  }

  const cli = readText(context.root, "src/setup-cli.ts");
  const prompts = readText(context.root, "src/setup/prompts.ts");
  const operations = readText(context.root, "src/setup/operations.ts");
  const template = readText(context.root, "templates/hy-workflow.yml");
  const workflow = readText(context.root, ".github/workflows/hy-workflow.yml");
  for (const token of ["setup", "unset", "--clients", "--yes", "--json", "--dry-run"]) {
    if (!cli.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup CLI is missing ${token}.`, file: "src/setup-cli.ts" });
  }
  if (!prompts.includes("@clack/prompts") || !prompts.includes("multiselect")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup TUI must use @clack/prompts with client multiselect.", file: "src/setup/prompts.ts" });
  }
  if (!cli.includes('mode: "shared"') || !cli.includes("--local has been removed")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup CLI must default to shared deployment and reject removed local mode.", file: "src/setup-cli.ts" });
  }
  if (prompts.includes("Choose deployment mode") || prompts.includes("选择部署模式")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup TUI must not offer a deployment-mode choice.", file: "src/setup/prompts.ts" });
  }
  if (!operations.includes("writeSharedArtifacts(root, config, options.dryRun)") || operations.includes('options.mode === "shared"')) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup must always maintain the shared config and workflow artifacts.", file: "src/setup/operations.ts" });
  }
  for (const client of ["codex", "claude", "opencode"]) {
    if (!operations.includes(client)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup operations must support ${client}.`, file: "src/setup/operations.ts" });
  }
  if (template !== workflow) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Checked-in workflow must exactly match the packaged workflow template.", file: ".github/workflows/hy-workflow.yml" });
  }
  for (const trigger of ["  push:\n", "  pull_request:\n"]) {
    if (!template.includes(trigger)) findings.push({ rule: "setup", severity: "hard_fail", message: `Workflow must include every ${trigger.trimEnd()} event.`, file: "templates/hy-workflow.yml" });
  }
  if (template.includes("paths:")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Workflow must not use path filters that can suppress required checks.", file: "templates/hy-workflow.yml" });
  }
  for (const token of [
    "hashFiles('package.json')",
    "hashFiles('package-lock.json')",
    "npm ci",
    "npm run build",
    "npm test",
    "git+https://github.com/voxServalG/doclint.git",
    "git+https://github.com/voxServalG/codelint.git",
    "status=$?",
    "JSON.parse",
    "report.ok === false",
    "nestedNumber('errors')",
    "nestedNumber('failed')",
    "compat_backup_dir=",
    "cp -a --",
    "trap restore_compat EXIT",
    "rm -rf -- \"$compat_backup_dir\"",
  ]) {
    if (!template.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Workflow is missing strict CI contract token: ${token}.`, file: "templates/hy-workflow.yml" });
  }
  for (const forbidden of ["github:voxServalG/", "|| true", "actions/upload-artifact"]) {
    if (template.includes(forbidden)) findings.push({ rule: "setup", severity: "hard_fail", message: `Workflow contains forbidden fail-open or persisted-artifact token: ${forbidden}.`, file: "templates/hy-workflow.yml" });
  }
  return findings;
}
