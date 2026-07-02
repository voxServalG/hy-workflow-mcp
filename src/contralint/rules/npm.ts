import { exists } from "../files.js";
import { npmPackDryRun, readPackageJson } from "../../npm/package.js";
import { trackedFiles } from "../../adapters/git.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_SCRIPTS = ["build", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "verify", "prepare"];
const FORBIDDEN_PACK_PREFIXES = [".hy/", ".opencode/", ".codex/", "test/", "src/", "node_modules/", "codelint.json", "doclint.json", "docs-gardener.json"];
const REQUIRED_PACK_FILES = ["dist", "docs", "setup", "setup.ps1", "README.md"];

export function checkNpmContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const pkg = readPackageJson(context.root);
  if (pkg.main !== "dist/server.js") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json main must be dist/server.js.", file: "package.json" });
  if (pkg.bin?.["hy-workflow"] !== "dist/server.js") findings.push({ rule: "npm", severity: "hard_fail", message: "hy-workflow bin must point at dist/server.js.", file: "package.json" });
  for (const script of REQUIRED_SCRIPTS) {
    if (!pkg.scripts?.[script]) findings.push({ rule: "npm", severity: "hard_fail", message: "Missing npm script " + script + ".", file: "package.json" });
  }
  const missingFiles = REQUIRED_PACK_FILES.filter(f => !pkg.files?.includes(f));
  if (missingFiles.length) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "package.json files missing: " + missingFiles.join(", "), file: "package.json" });
  }
  const tracked = trackedFiles(context.root);
  if (tracked.some(f => f.startsWith("dist/"))) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "dist files must not be tracked by git.", file: ".gitignore" });
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
