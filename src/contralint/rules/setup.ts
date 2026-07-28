import { exists, readText } from "../files.js";
import { renderWorkflowTemplate } from "../../setup/shared.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const ROOT_CONFIG_DOC_STATEMENT = "MCP runtime accepts only the root `hy-workflow.json`; legacy user config may be read only by setup/config CLI as a migration input.";
const ROOT_CONFIG_DOCS = [
  "docs/architecture.md",
  "docs/errors.md",
  "docs/setup.md",
  "docs/tools.md",
];

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
  const renderedWorkflow = renderWorkflowTemplate();
  const config = readText(context.root, "src/config.ts");
  const init = readText(context.root, "src/tools/init.ts");
  const runtimeProject = readText(context.root, "src/runtime/project.ts");
  const sharedText = readText(context.root, "src/setup/shared.ts");
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
  if (!operations.includes("writeSharedArtifacts(") || !operations.includes("SHARED_PROJECT_FILES") || operations.includes('options.mode === "shared"')) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup must always maintain the shared config, workflow, and managed AGENTS block artifacts.", file: "src/setup/operations.ts" });
  }
  for (const token of ["planAgentsFile", "AGENTS_FILE", "outsidePreserved"]) {
    if (!exists(context.root, "src/setup/agents-rules.ts") || !readText(context.root, "src/setup/agents-rules.ts").includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `agents-rules module must expose ${token}.`, file: "src/setup/agents-rules.ts" });
    }
  }
  if (!sharedText?.includes("AGENTS_FILE") || !sharedText?.includes("planAgentsFile")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "shared artifact plan must include AGENTS.md managed by agents-rules.", file: "src/setup/shared.ts" });
  }
  for (const client of ["codex", "claude", "opencode"]) {
    if (!operations.includes(client)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup operations must support ${client}.`, file: "src/setup/operations.ts" });
  }
  if (renderedWorkflow !== workflow) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Checked-in workflow must exactly match the deterministically rendered packaged workflow template.", file: ".github/workflows/hy-workflow.yml" });
  }
  for (const trigger of ["  pull_request:\n", "  workflow_dispatch:\n"]) {
    if (!template.includes(trigger)) findings.push({ rule: "setup", severity: "hard_fail", message: `Workflow must include every ${trigger.trimEnd()} event.`, file: "templates/hy-workflow.yml" });
  }
  if (template.includes("  push:\n")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Generated workflow must not run on generic push events.", file: "templates/hy-workflow.yml" });
  }
  if (template.includes("paths:")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Workflow must not use path filters that can suppress required checks.", file: "templates/hy-workflow.yml" });
  }
  for (const token of [
    "npm ci",
    "pnpm install --frozen-lockfile",
    "yarn install --immutable",
    "bun install --frozen-lockfile",
    "python -m pytest",
    "go test ./...",
    "cargo test --workspace --all-targets",
    "ci.commands",
    "npm run build",
    "npm test",
    "Run built-in doclint and codelint",
    "__HY_WORKFLOW_LINT_BUNDLE_BASE64__",
    "HY_WORKFLOW_INTERNAL_LINT_BUNDLE",
    "requiredModules",
    "RUNNER_TEMP",
    "JSON.parse",
    "permissions:\n  contents: read",
    "hy-workflow.lint.v1",
    "report.counts.docs <= 0",
    "report.ok !== true",
    "report.counts.errors > 0",
    "fs.rmSync(runnerRoot",
    "persist-credentials: false",
    "name: Windows Smoke",
    "if: ${{ github.repository == 'voxServalG/hy-workflow-mcp' }}",
    "runs-on: windows-latest",
    "npm run test:windows",
  ]) {
    if (!template.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Workflow is missing strict CI contract token: ${token}.`, file: "templates/hy-workflow.yml" });
  }
  for (const forbidden of [
    "  push:\n",
    "github:voxServalG/",
    "codeload.github.com",
    "npx --yes --package",
    "curl ",
    "compat_backup",
    "codelint.json",
    "doclint.json",
    "docs-gardener.json",
    "|| true",
    "actions/upload-artifact",
    "contents: write",
    "actions: write",
    "checks: write",
    "pull-requests: write",
    "id-token: write",
  ]) {
    if (template.includes(forbidden)) findings.push({ rule: "setup", severity: "hard_fail", message: `Workflow contains forbidden fail-open or persisted-artifact token: ${forbidden}.`, file: "templates/hy-workflow.yml" });
  }
  if (template.includes("- uses: actions/setup-node@v4\n        if:")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup-node must be unconditional because mandatory doclint/codelint run for every ecosystem.", file: "templates/hy-workflow.yml" });
  }
  if ((template.match(/persist-credentials: false/g) ?? []).length !== 2) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Every checkout in the generated workflow must disable persisted credentials.", file: "templates/hy-workflow.yml" });
  }
  for (const token of [
    "return path.join(root, UNIFIED_CONFIG_FILE)",
    "const source = path.join(root, UNIFIED_CONFIG_FILE)",
    "const localPath = projectPaths(root).config",
    'readJsonPath(localPath, "local project config")',
  ]) {
    if (!config.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Config source/migration contract is missing ${token}.`, file: "src/config.ts" });
  }
  for (const token of [
    "const configPath = path.join(root, UNIFIED_CONFIG_FILE)",
    "if (!fs.existsSync(configPath)) return setupMissingResult([configPath])",
    "const configStatus = checkConfig(root)",
  ]) {
    if (!init.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `hy_init root-config guard is missing ${token}.`, file: "src/tools/init.ts" });
  }
  for (const forbidden of ["projectPaths(root).config", 'path.join(root, "codelint.json")']) {
    if (runtimeProject.includes(forbidden)) findings.push({ rule: "setup", severity: "hard_fail", message: `MCP runtime must not fall back to a legacy configuration source: ${forbidden}.`, file: "src/runtime/project.ts" });
  }
  if (!runtimeProject.includes("requireRuntimeBaseBranch(root)")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "MCP runtime must load project.baseBranch through the root-only config helper.", file: "src/runtime/project.ts" });
  }
  for (const file of ROOT_CONFIG_DOCS) {
    if (!readText(context.root, file).includes(ROOT_CONFIG_DOC_STATEMENT)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: "Documentation must state the root-only runtime config and setup/config-only migration boundary.", file });
    }
  }
  return findings;
}
