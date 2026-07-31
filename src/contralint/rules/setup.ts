import { exists, readText } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const AUTHORITY_TOKENS = [
  "projectPaths(root).config",
  "isProjectRuntimeConfigSource",
  "RUNTIME_CONFIG_SOURCE_ENV",
  "RUNTIME_CONFIG_SOURCE_SCHEMA",
  "legacyDetectedConfig",
  "LEGACY_COMPATIBLE_POLICY_PROFILE",
] as const;

export function checkSetupContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  for (const legacy of ["setup", "setup.ps1"]) {
    if (exists(context.root, legacy)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Legacy platform setup script must be removed: ${legacy}.`, file: legacy });
    }
  }

  const mainPath = "src/main.ts";
  const helperCliPath = "src/helper/cli.ts";
  const helperCliContractPath = "src/helper/cli-contract.ts";
  const helperCliPresentationPath = "src/helper/cli-presentation.ts";
  const helperCliPaths = [helperCliPath, helperCliContractPath, helperCliPresentationPath] as const;
  const helperProjectPath = "src/helper/project.ts";
  for (const file of [mainPath, ...helperCliPaths, helperProjectPath]) {
    if (!exists(context.root, file)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Public helper module is missing: ${file}.`, file });
    }
  }
  if (findings.some(finding => finding.severity === "hard_fail" && finding.file && [mainPath, ...helperCliPaths, helperProjectPath].includes(finding.file))) {
    return findings;
  }

  const main = readText(context.root, mainPath);
  const helperCli = helperCliPaths.map(file => readText(context.root, file)).join("\n");
  const helperProject = readText(context.root, helperProjectPath);
  for (const token of ["runHelperCli", 'argv[0] === "helper"', 'argv[0] === "setup"', '"install"']) {
    if (!main.includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Public CLI setup/helper routing is missing ${token}.`, file: mainPath });
    }
  }
  for (const forbidden of ["runSetupCli", "./setup-cli.js", "StdioServerTransport", "@modelcontextprotocol/sdk"]) {
    if (main.includes(forbidden)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Public CLI must use helper install rather than the legacy setup/MCP path: ${forbidden}.`, file: mainPath });
    }
  }

  for (const token of [
    'HELPER_CLI_SCHEMA = "hy-workflow.helper.v1"',
    'HELPER_CLI_COMMANDS = ["install", "update", "status", "remove"]',
    "installHelperSkills",
    "registerHelperProject",
    "retireOwnedWorkflowMcp",
    "projectFilesChanged: []",
  ]) {
    if (!helperCli.includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Helper CLI contract is missing ${token}.`, file: helperCliPath });
    }
  }
  for (const token of [
    "assertHelperResourcesExternal",
    "assertSafeRuntimeBoundary",
    "projectPaths(root)",
    "projectFiles: []",
    "projectFilesChanged: []",
    "atomicWriteJson(paths.config",
  ]) {
    if (!helperProject.includes(token)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `External-only helper registration is missing ${token}.`, file: helperProjectPath });
    }
  }
  const publicHelper = main + "\n" + helperCli + "\n" + helperProject;
  for (const forbidden of [
    ".github/workflows/hy-workflow.yml",
    "writeSharedArtifacts",
    "renderWorkflowTemplate",
    "SHARED_PROJECT_FILES",
    "AGENTS.md",
  ]) {
    if (publicHelper.includes(forbidden)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: `Public setup/helper must not inject project files; found ${forbidden}.`, file: helperProject.includes(forbidden) ? helperProjectPath : helperCli.includes(forbidden) ? helperCliPath : mainPath });
    }
  }

  const configPath = "src/config.ts";
  const config = readText(context.root, configPath);
  for (const token of AUTHORITY_TOKENS) {
    if (!config.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Runtime configuration authority contract is missing ${token}.`, file: configPath });
  }
  if (!config.includes("if (externalRead.value && isProjectRuntimeConfigSource(externalRead.value))")
      || !config.includes("if (process.env[RUNTIME_CONFIG_SOURCE_ENV] === RUNTIME_CONFIG_SOURCE_SCHEMA)")) {
    findings.push({ rule: "setup", severity: "hard_fail", message: "Root config may be selected only by the exact external authority marker or exact CI signal.", file: configPath });
  }

  // The legacy opt-in workflow template remains a packaged compatibility
  // artifact, but the public helper never installs it. Keep its security
  // properties machine checked while it exists.
  const templatePath = "templates/hy-workflow.yml";
  if (exists(context.root, templatePath)) {
    const template = readText(context.root, templatePath);
    for (const token of [
      "permissions:\n  contents: read",
      "persist-credentials: false",
      "__HY_WORKFLOW_PACKAGE_SPEC__",
      "hy-workflow lint --json",
    ]) {
      if (!template.includes(token)) findings.push({ rule: "setup", severity: "hard_fail", message: `Optional workflow template is missing ${token}.`, file: templatePath });
    }
    if (!/actions\/checkout@[0-9a-f]{40}/.test(template)) {
      findings.push({ rule: "setup", severity: "hard_fail", message: "Optional workflow checkout must use an immutable 40-hex commit.", file: templatePath });
    }
    for (const forbidden of [
      "  push:\n", "contents: write", "actions: write", "checks: write",
      "pull-requests: write", "id-token: write", "|| true",
      "codelint.json", "doclint.json", "docs-gardener.json",
    ]) {
      if (template.includes(forbidden)) findings.push({ rule: "setup", severity: "hard_fail", message: `Optional workflow template contains unsafe or legacy token ${forbidden}.`, file: templatePath });
    }
  }
  return findings;
}
