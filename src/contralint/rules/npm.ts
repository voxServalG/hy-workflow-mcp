import { exists, readText } from "../files.js";
import { npmPackDryRun, readPackageJson } from "../../npm/package.js";
import { trackedFiles } from "../../adapters/git.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_SCRIPTS = ["build", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "verify", "prepack", "prepublishOnly"];
const FORBIDDEN_PACK_PREFIXES = [".hy/", ".opencode/", ".codex/", "test/", "src/", "node_modules/", "codelint.json", "doclint.json", "docs-gardener.json"];
const REQUIRED_PACK_FILES = ["dist", "docs", "setup", "setup.ps1", "README.md"];

export function checkNpmContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const pkg = readPackageJson(context.root);
  if (pkg.name !== "@voxstudio/hy-workflow") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json name must be @voxstudio/hy-workflow.", file: "package.json" });
  if (pkg.publishConfig?.access !== "public") findings.push({ rule: "npm", severity: "hard_fail", message: "Scoped npm package must publish with public access.", file: "package.json" });
  if (typeof pkg.repository === "string" || pkg.repository?.url !== "git+https://github.com/voxServalG/hy-workflow-mcp.git") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json repository must match the public GitHub source.", file: "package.json" });
  if (pkg.main !== "dist/server.js") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json main must be dist/server.js.", file: "package.json" });
  if (pkg.bin?.["hy-workflow"] !== "dist/server.js") findings.push({ rule: "npm", severity: "hard_fail", message: "hy-workflow bin must point at dist/server.js.", file: "package.json" });
  for (const script of ["prepare", "install", "postinstall"]) {
    if (pkg.scripts?.[script]) findings.push({ rule: "npm", severity: "hard_fail", message: `${script} must not build during npm install.`, file: "package.json" });
  }
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
    const packFiles = npmPackDryRun(context.root);
    if (!packFiles.includes("dist/server.js")) findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack must include dist/server.js.", file: "package.json" });
    for (const file of packFiles) {
      if (FORBIDDEN_PACK_PREFIXES.some(prefix => file === prefix.replace(/\/$/, "") || file.startsWith(prefix))) {
        findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack includes forbidden file " + file + ".", file: "package.json" });
      }
    }
  }
  const publishWorkflowPath = ".github/workflows/npm-publish.yml";
  if (!exists(context.root, publishWorkflowPath)) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "Missing npm trusted-publishing workflow.", file: publishWorkflowPath });
  } else {
    const workflow = readText(context.root, publishWorkflowPath);
    for (const token of ["id-token: write", "npm publish --access public --tag next", "npm publish --access public --tag latest"]) {
      if (!workflow.includes(token)) findings.push({ rule: "npm", severity: "hard_fail", message: `npm publish workflow is missing ${token}.`, file: publishWorkflowPath });
    }
    for (const token of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "upload-artifact", "gh release upload", "actions/attest-build-provenance"]) {
      if (workflow.includes(token)) findings.push({ rule: "npm", severity: "hard_fail", message: `npm publish workflow must not contain ${token}.`, file: publishWorkflowPath });
    }
  }
  return findings;
}
