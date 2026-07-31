import { exists, readText } from "../files.js";
import { npmPackDryRun, readPackageJson } from "../../npm/package.js";
import { trackedFiles } from "../../git.js";
import { SKILL_PATHS } from "../../skills/catalog.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const REQUIRED_SCRIPTS = ["clean", "build", "lint", "lint:contract", "test", "test:unit", "test:e2e", "test:contract", "test:acceptance", "test:windows", "verify", "prepack", "prepublishOnly"];
const FORBIDDEN_PACK_PREFIXES = [".hy/", ".opencode/", ".codex/", "test/", "src/", "node_modules/", "codelint.json", "doclint.json", "docs-gardener.json"];
const REQUIRED_PACK_FILES = ["dist", "docs", "schemas", "templates", "skills", "README.md"];

export function checkNpmContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  const pkg = readPackageJson(context.root);
  if (pkg.name !== "@voxstudio/hy-workflow") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json name must be @voxstudio/hy-workflow.", file: "package.json" });
  if (pkg.publishConfig?.access !== "public") findings.push({ rule: "npm", severity: "hard_fail", message: "Scoped npm package must publish with public access.", file: "package.json" });
  if (typeof pkg.repository === "string" || pkg.repository?.url !== "git+https://github.com/voxServalG/hy-workflow-mcp.git") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json repository must match the public GitHub source.", file: "package.json" });
  if (pkg.main !== "dist/main.js") findings.push({ rule: "npm", severity: "hard_fail", message: "package.json main must be dist/main.js.", file: "package.json" });
  if (pkg.bin?.["hy-workflow"] !== "dist/main.js") findings.push({ rule: "npm", severity: "hard_fail", message: "hy-workflow bin must point at dist/main.js.", file: "package.json" });
  for (const value of [pkg.main, ...Object.values(pkg.bin ?? {}), ...Object.values(pkg.scripts ?? {})]) {
    if (typeof value === "string" && (value.includes("dist/server.js") || value.includes("src/server.ts"))) {
      findings.push({ rule: "npm", severity: "hard_fail", message: "Package entrypoints and scripts must not start the removed MCP server.", file: "package.json" });
    }
  }
  if (pkg.scripts?.clean !== "node scripts/clean-dist.mjs" || !pkg.scripts?.build?.startsWith("npm run clean && ")) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "Every build must clean dist with the cross-platform Node cleaner before compiling.", file: "package.json" });
  }
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
  if (exists(context.root, "dist/main.js")) {
    const packFiles = npmPackDryRun(context.root);
    if (!packFiles.includes("dist/main.js")) findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack must include dist/main.js.", file: "package.json" });
    if (packFiles.includes("dist/server.js")) findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack must not include the removed MCP server entrypoint.", file: "package.json" });
    for (const file of packFiles) {
      if (FORBIDDEN_PACK_PREFIXES.some(prefix => file === prefix.replace(/\/$/, "") || file.startsWith(prefix))) {
        findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack includes forbidden file " + file + ".", file: "package.json" });
      }
    }
    if (!packFiles.includes("templates/hy-workflow.yml")) {
      findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack must include templates/hy-workflow.yml.", file: "package.json" });
    }
    const packedSkills = packFiles.filter(file => /^skills\/[^/]+\/SKILL\.md$/.test(file)).sort();
    const expectedSkills = [...SKILL_PATHS].sort();
    if (JSON.stringify(packedSkills) !== JSON.stringify(expectedSkills)) {
      findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack must include exactly the 12 canonical stage Skills.", file: "package.json", detail: { expected: expectedSkills, actual: packedSkills } });
    }
    for (const file of ["code.mjs", "docs.mjs", "fs.mjs", "index.mjs", "markdown.mjs", "python.mjs", "rust.mjs"]) {
      if (!packFiles.includes(`templates/lint/${file}`)) findings.push({ rule: "npm", severity: "hard_fail", message: `npm pack must include templates/lint/${file}.`, file: "package.json" });
    }
    if (packFiles.includes("AGENTS.md")) {
      findings.push({ rule: "npm", severity: "hard_fail", message: "npm pack must not include AGENTS.md; it is not a setup artifact or contract source.", file: "package.json" });
    }
  }
  const publishWorkflowPath = ".github/workflows/npm-publish.yml";
  if (!exists(context.root, publishWorkflowPath)) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "Missing npm trusted-publishing workflow.", file: publishWorkflowPath });
  } else {
    const workflow = readText(context.root, publishWorkflowPath);
    for (const token of [
      "id-token: write",
      "fetch-depth: 0",
      "npm@11.13.0",
      "Validate release provenance",
      "release tag must equal v",
      "package semver prerelease state must match GitHub release.prerelease",
      "git merge-base --is-ancestor",
      "refs/remotes/origin/main",
      "Build one release tarball",
      'npm run test:acceptance -- --package-archive "$HY_RELEASE_TGZ"',
      'test "$actual_sha512" = "$HY_RELEASE_TGZ_SHA512"',
      'npm publish "$HY_RELEASE_TGZ" --access public --tag next',
      'npm publish "$HY_RELEASE_TGZ" --access public --tag latest',
    ]) {
      if (!workflow.includes(token)) findings.push({ rule: "npm", severity: "hard_fail", message: `npm publish workflow is missing ${token}.`, file: publishWorkflowPath });
    }
    if (workflow.indexOf("Validate release provenance") > workflow.indexOf("npm run verify")) {
      findings.push({ rule: "npm", severity: "hard_fail", message: "Release provenance must be validated before verification and publishing.", file: publishWorkflowPath });
    }
    if (workflow.indexOf("--package-archive") > workflow.indexOf('npm publish "$HY_RELEASE_TGZ"')) {
      findings.push({ rule: "npm", severity: "hard_fail", message: "Release acceptance must consume the exact tarball before that tarball is published.", file: publishWorkflowPath });
    }
    for (const token of ["NODE_AUTH_TOKEN", "NPM_TOKEN", "upload-artifact", "gh release upload", "actions/attest-build-provenance"]) {
      if (workflow.includes(token)) findings.push({ rule: "npm", severity: "hard_fail", message: `npm publish workflow must not contain ${token}.`, file: publishWorkflowPath });
    }
  }
  if (!exists(context.root, "docs/acceptance.md")) {
    findings.push({ rule: "npm", severity: "hard_fail", message: "Release acceptance pressure-test contract must be documented.", file: "docs/acceptance.md" });
  }
  for (const [file, tokens] of Object.entries({
    "test/acceptance/runner.ts": ["packAndInstall", "--package-archive", "expectedScenarios", "skipped: []", "terminateAllAcceptanceChildren"],
    "test/acceptance/harness.ts": ["run(\"npm\", [\"pack\"", "run(\"npm\", [\"install\"", "GIT_TERMINAL_PROMPT", "CODEX_HOME", "git push", "npm publish"],
    "test/acceptance/scenarios.ts": ["concurrency-32", "helper-fault-child.mjs", "runRepositoryLintPressure", "assertCompatibilityUnchanged", 'run("hy-workflow", ["lint", "--json"]'],
    "test/acceptance/helper-fault-child.mjs": ["afterMutation", "beforeManifestWrite", "updateHelperSkills", "removeHelperSkills"],
    "test/acceptance/lint-report.ts": ["validateLintPressureEnvelope", "hy-workflow.lint.v1", "notApplicableRules", "notConfiguredRules", "D001", "C005"],
    "test/acceptance/baseline-matrix.json": ["seamless-upgrade", "INC-UPGRADE-INJECTION-INTERFERENCE"],
    "test/acceptance/baseline-scenarios.ts": ["runSeamlessUpgradeIncident", "legacyFiles", "byte-for-byte"],
    "test/acceptance/matrix.json": ["https://", "5e16a5c9e57e81f6031a23faa2ace52205fa8242"],
  })) {
    const text = readText(context.root, file);
    for (const token of tokens) {
      if (!text.includes(token)) findings.push({ rule: "npm", severity: "hard_fail", message: `Acceptance contract is missing ${token}.`, file });
    }
  }
  const acceptance = readText(context.root, "test/acceptance/scenarios.ts");
  for (const removed of ["--print-managed-rules", "auto-migrate stale AGENTS", "project-shadow", "--ci-command"]) {
    if (acceptance.includes(removed)) {
      findings.push({ rule: "npm", severity: "hard_fail", message: `Acceptance must test seamless upgrade and the two-artifact boundary, not removed legacy behavior: ${removed}.`, file: "test/acceptance/scenarios.ts" });
    }
  }
  const publicMain = readText(context.root, "src/main.ts");
  for (const token of ["@modelcontextprotocol/sdk", "StdioServerTransport", "server.connect("]) {
    if (publicMain.includes(token)) {
      findings.push({ rule: "npm", severity: "hard_fail", message: `Published main entrypoint must not start MCP: ${token}.`, file: "src/main.ts" });
    }
  }
  for (const file of ["test/acceptance/scenarios.ts", "test/acceptance/runner.ts", "test/acceptance/lint-report.ts"]) {
    const text = readText(context.root, file);
    for (const forbidden of ["codeload.github.com", "DOCLINT_SOURCE", "CODELINT_SOURCE", "prepareLintPressurePackages", "HY_ACCEPTANCE_LINT_ARCHIVE_DIR", "npx --yes --package"]) {
      if (text.includes(forbidden)) findings.push({ rule: "npm", severity: "hard_fail", message: `Built-in lint acceptance must not contain ${forbidden}.`, file });
    }
  }
  return findings;
}
