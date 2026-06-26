import { exists } from "../files.js";
import { npmPackDryRun, readPackageJson } from "../../adapters/npm-package.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_SCRIPTS = ["build", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "verify"];
const FORBIDDEN_PACK_PREFIXES = [".hy/", ".opencode/", ".codex/", "test/", "src/", "node_modules/", "codelint.json", "doclint.json", "docs-gardener.json"];

export function checkNpmContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const pkg = readPackageJson(context.root);
  if (pkg.main !== "dist/server.js") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json main must be dist/server.js.", file: "package.json" });
  if (pkg.bin?.["hy-workflow"] !== "dist/server.js") findings.push({ rule: "npm", severity: "hard_fail", message: "hy-workflow bin must point at dist/server.js.", file: "package.json" });
  for (const script of REQUIRED_SCRIPTS) {
    if (!pkg.scripts?.[script]) findings.push({ rule: "npm", severity: "hard_fail", message: "Missing npm script " + script + ".", file: "package.json" });
  }
  if (!pkg.files?.includes("dist") || !pkg.files?.includes("docs") || !pkg.files?.includes("README.md")) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "package.json files must keep the npm package minimal and runtime-oriented.", file: "package.json" });
  }
  if (exists(context.root, "dist/server.js")) {
    for (const file of npmPackDryRun(context.root)) {
      if (FORBIDDEN_PACK_PREFIXES.some(prefix => file === prefix.replace(/\/$/, "") || file.startsWith(prefix))) {
        findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack includes forbidden file " + file + ".", file: "package.json" });
      }
    }
  }
  return findings;
}

