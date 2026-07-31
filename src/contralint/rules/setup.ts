import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const PROJECT_ARTIFACTS = ["hy-workflow.json", ".github/workflows/hy-workflow.yml"] as const;
const AUTHORITY_DOC_TOKENS = [
  "complete external",
  "exact external",
  "HY_WORKFLOW_RUNTIME_CONFIG_SOURCE",
  "read-only project detection",
  "frozen legacy-compatible defaults",
] as const;
const INERT_LEGACY_DOC_TOKENS = [
  "do not read",
  "hash",
  "validate",
  "rewrite",
  "move",
  "delete",
  "upgrade gate",
  "byte-for-byte untouched",
] as const;

function count(text: string, token: string): number {
  return text.split(token).length - 1;
}

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
  const shared = readText(context.root, "src/setup/shared.ts");
  const template = readText(context.root, "templates/hy-workflow.yml");
  const config = readText(context.root, "src/config.ts");
  const setupDocs = readText(context.root, "docs/setup.md");
  const architectureDocs = readText(context.root, "docs/architecture.md");

  for (const token of ["setup", "unset", "--clients", "--yes", "--json", "--dry-run"]) {
    if (!cli.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup CLI is missing ${token}.`, file: "src/setup-cli.ts" });
  }
  if (!prompts.includes("@clack/prompts") || !prompts.includes("multiselect")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup TUI must use @clack/prompts with client multiselect.", file: "src/setup/prompts.ts" });
  }
  if (!cli.includes('mode: "shared"') || !cli.includes("--local has been removed")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup CLI must use the single current deployment model and reject removed local mode.", file: "src/setup-cli.ts" });
  }
  if (prompts.includes("Choose deployment mode") || prompts.includes("选择部署模式")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "setup TUI must not offer a deployment-mode choice.", file: "src/setup/prompts.ts" });
  }
  if (!operations.includes("writeSharedArtifacts(") || operations.includes('options.mode === "shared"')) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Fresh setup must maintain the two current project artifacts without a deployment-mode branch.", file: "src/setup/operations.ts" });
  }
  for (const token of PROJECT_ARTIFACTS) {
    if (!shared.includes(`"${token}"`)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Shared artifact plan must include ${token}.`, file: "src/setup/shared.ts" });
    }
  }
  if (!shared.includes("SHARED_PROJECT_FILES = [CONFIG_FILE, WORKFLOW_FILE]")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Fresh setup must expose exactly the config and thin workflow as project artifacts.", file: "src/setup/shared.ts" });
  }
  for (const forbidden of ["AGENTS_FILE", "planAgentsFile", "agents-rules", "AGENTS.md"]) {
    if (shared.includes(forbidden) || operations.includes(forbidden)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Setup must not create or manage AGENTS.md; found ${forbidden}.`, file: shared.includes(forbidden) ? "src/setup/shared.ts" : "src/setup/operations.ts" });
    }
  }
  for (const client of ["codex", "claude", "opencode"]) {
    if (!operations.includes(client)) findings.push({ rule: "setup", severity: "hard_fail", message: `setup operations must support ${client}.`, file: "src/setup/operations.ts" });
  }

  for (const trigger of ["  pull_request:\n", "  workflow_dispatch:\n"]) {
    if (!template.includes(trigger)) findings.push({ rule: "setup", severity: "hard_fail", message: `Thin workflow must include ${trigger.trim()}.`, file: "templates/hy-workflow.yml" });
  }
  for (const token of [
    "permissions:\n  contents: read",
    "HY_WORKFLOW_RUNTIME_CONFIG_SOURCE: hy-workflow.runtime-config-source.v1",
    "persist-credentials: false",
    "__HY_WORKFLOW_PACKAGE_SPEC__",
    "hy-workflow lint --json",
  ]) {
    if (!template.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Thin workflow is missing ${token}.`, file: "templates/hy-workflow.yml" });
  }
  if (!/actions\/checkout@[0-9a-f]{40}/.test(template)) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Thin workflow checkout must use an immutable 40-hex commit.", file: "templates/hy-workflow.yml" });
  }
  if (count(template, "__HY_WORKFLOW_PACKAGE_SPEC__") !== 1 || count(template, "hy-workflow lint --json") !== 1) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Thin workflow must contain exactly one package placeholder and one centralized lint invocation.", file: "templates/hy-workflow.yml" });
  }
  for (const forbidden of [
    "  push:\n", "paths:", "ci.commands", "__HY_WORKFLOW_LINT_BUNDLE_BASE64__",
    "HY_WORKFLOW_INTERNAL_LINT_BUNDLE", "RUNNER_TEMP", "windows-latest",
    "npm run build", "npm test", "python -m pytest", "go test ./...", "cargo test",
    "codelint.json", "doclint.json", "docs-gardener.json", "actions/upload-artifact",
    "contents: write", "actions: write", "checks: write", "pull-requests: write",
    "id-token: write", "|| true",
  ]) {
    if (template.includes(forbidden)) findings.push({ rule: "setup", severity: "hard_fail", message: `Thin workflow contains removed inference, payload, permission, or legacy token: ${forbidden}.`, file: "templates/hy-workflow.yml" });
  }

  for (const token of [
    "projectPaths(root).config", "isProjectRuntimeConfigSource", "RUNTIME_CONFIG_SOURCE_ENV",
    "RUNTIME_CONFIG_SOURCE_SCHEMA", "legacyDetectedConfig", "LEGACY_COMPATIBLE_POLICY_PROFILE",
  ]) {
    if (!config.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Runtime configuration authority contract is missing ${token}.`, file: "src/config.ts" });
  }
  if (!config.includes("if (externalRead.value && isProjectRuntimeConfigSource(externalRead.value))")
      || !config.includes("if (process.env[RUNTIME_CONFIG_SOURCE_ENV] === RUNTIME_CONFIG_SOURCE_SCHEMA)")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Root config may be selected only by the exact external authority marker or exact CI signal.", file: "src/config.ts" });
  }

  for (const token of AUTHORITY_DOC_TOKENS) {
    if (!architectureDocs.includes(token) && !setupDocs.includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Configuration authority documentation is missing ${token}.`, file: "docs/architecture.md" });
    }
  }
  for (const token of INERT_LEGACY_DOC_TOKENS) {
    if (!setupDocs.includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Seamless-upgrade documentation must say legacy injections are inert; missing ${token}.`, file: "docs/setup.md" });
    }
  }
  for (const token of ["writes only `hy-workflow.json` and `.github/workflows/hy-workflow.yml`", "does not inject `AGENTS.md`"]) {
    if (!architectureDocs.includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Architecture must document the two-artifact boundary: ${token}.`, file: "docs/architecture.md" });
    }
  }
  return findings;
}
