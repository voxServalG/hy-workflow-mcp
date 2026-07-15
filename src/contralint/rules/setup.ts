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
  for (const token of ["setup", "unset", "--clients", "--yes", "--json", "--dry-run", "--shared"]) {
    if (!cli.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup CLI is missing ${token}.`, file: "src/setup-cli.ts" });
  }
  if (!prompts.includes("@clack/prompts") || !prompts.includes("multiselect")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup TUI must use @clack/prompts with client multiselect.", file: "src/setup/prompts.ts" });
  }
  for (const client of ["codex", "claude", "opencode"]) {
    if (!operations.includes(client)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup operations must support ${client}.`, file: "src/setup/operations.ts" });
  }
  if (!template.includes("npm run build") || !template.includes("npm test")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Shared workflow template must run build and tests.", file: "templates/hy-workflow.yml" });
  }
  return findings;
}
