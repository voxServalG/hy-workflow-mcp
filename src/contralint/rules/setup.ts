import type { ContractFinding, ContractRuleContext } from "../types.js";
import { readText } from "../files.js";

export function checkSetupContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];

  // Verify setup script mentions all tracked artifacts
  const setup = readText(context.root, "setup");
  if (!setup.includes(".github/workflows/hy-workflow.yml"))
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup must deploy CI workflow.", file: "setup" });
  if (!setup.includes("hy-workflow.json"))
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup must deploy unified config.", file: "setup" });
  if (!setup.includes("SETUP_VERSION"))
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup must define SETUP_VERSION.", file: "setup" });
  if (!setup.includes("npm run build") && !setup.includes("npm ci"))
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup CI must include build.", file: "setup" });
  if (!setup.includes("doclint") && !setup.includes("codelint"))
    findings.push({ rule: "setup", severity: "warning", message: "setup CI should include doclint and codelint.", file: "setup" });

  // Verify bootstrap.ts matches setup version
  const bootstrap = readText(context.root, "src/bootstrap.ts");
  const setupVersion = setup.match(/SETUP_VERSION="([^"]+)"/)?.[1];
  if (setupVersion) {
    if (!bootstrap.includes(setupVersion))
      findings.push({ rule: "setup", severity: "hard_fail", message: `src/bootstrap.ts SETUP_VERSION must match setup: ${setupVersion}`, file: "src/bootstrap.ts" });
  }

  return findings;
}
