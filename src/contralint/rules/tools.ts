import {
  CLI_COMMAND_NAMES,
  COMMAND_CONTRACTS,
  LEGACY_ACTION_NAMES,
  assertCommandCatalogMatchesCli,
} from "../../commands/catalog.js";
import { WORKFLOW_CLI_COMMANDS } from "../../cli/workflow.js";
import { exists, readText, walkFiles } from "../files.js";
import type { ContractFinding, ContractRuleContext } from "../types.js";

const MCP_START_TOKENS = [
  "@modelcontextprotocol/sdk",
  "StdioServerTransport",
  "new Server(",
  "server.connect(",
] as const;

export function checkToolContracts(context: ContractRuleContext): ContractFinding[] {
  const findings: ContractFinding[] = [];
  try {
    assertCommandCatalogMatchesCli(WORKFLOW_CLI_COMMANDS);
  } catch (error: any) {
    findings.push({ rule: "tools", severity: "hard_fail", message: error?.message ?? String(error), file: "src/cli/workflow.ts" });
  }

  if (exists(context.root, "src/server.ts")) {
    findings.push({ rule: "tools", severity: "hard_fail", message: "The removed MCP server entrypoint must not exist.", file: "src/server.ts" });
  }
  const cliPath = "src/cli/workflow.ts";
  const mainPath = "src/main.ts";
  if (!exists(context.root, cliPath) || !exists(context.root, mainPath)) {
    if (!exists(context.root, cliPath)) findings.push({ rule: "tools", severity: "hard_fail", message: "Missing workflow CLI adapter.", file: cliPath });
    if (!exists(context.root, mainPath)) findings.push({ rule: "tools", severity: "hard_fail", message: "Missing CLI package entrypoint.", file: mainPath });
    return findings;
  }
  const cli = readText(context.root, cliPath);
  const main = readText(context.root, mainPath);

  for (const token of MCP_START_TOKENS) {
    if (cli.includes(token) || main.includes(token)) {
      findings.push({ rule: "tools", severity: "hard_fail", message: `Public CLI source must not start MCP; found ${token}.`, file: cli.includes(token) ? cliPath : mainPath });
    }
  }
  for (const token of ["runWorkflowCli", "WORKFLOW_CLI_COMMANDS", "hy-workflow.cli.v1"]) {
    if (!main.includes(token) && !cli.includes(token)) {
      findings.push({ rule: "tools", severity: "hard_fail", message: `CLI entrypoint contract is missing ${token}.`, file: token === "runWorkflowCli" ? mainPath : cliPath });
    }
  }

  const commands = new Set<string>();
  const actions = new Set<string>();
  for (const contract of COMMAND_CONTRACTS) {
    if (commands.has(contract.command)) findings.push({ rule: "tools", severity: "hard_fail", message: `Duplicate CLI command ${contract.command}.`, file: "src/commands/catalog.ts" });
    if (actions.has(contract.legacyAction)) findings.push({ rule: "tools", severity: "hard_fail", message: `Duplicate legacy kernel action ${contract.legacyAction}.`, file: "src/commands/catalog.ts" });
    commands.add(contract.command);
    actions.add(contract.legacyAction);
    if (!exists(context.root, contract.handlerFile)) {
      findings.push({ rule: "tools", severity: "hard_fail", message: `Handler is missing for CLI command ${contract.command}.`, file: contract.handlerFile });
    }
    const compiledImport = contract.handlerFile.replace(/^src\//, "../").replace(/\.ts$/, ".js");
    if (!cli.includes(compiledImport)) {
      findings.push({ rule: "tools", severity: "hard_fail", message: `CLI adapter does not import the cataloged handler for ${contract.command}.`, file: cliPath, detail: { handlerFile: contract.handlerFile } });
    }
    if (!cli.includes(`tool: "${contract.legacyAction}"`)) {
      findings.push({ rule: "tools", severity: "hard_fail", message: `CLI adapter does not bind ${contract.command} to its legacy kernel action.`, file: cliPath });
    }
    if (!contract.phases.length || !contract.stages.length) {
      findings.push({ rule: "tools", severity: "hard_fail", message: `CLI command ${contract.command} lacks phase/stage ownership.`, file: "src/commands/catalog.ts" });
    }
  }
  if (commands.size !== 15 || actions.size !== 15
      || CLI_COMMAND_NAMES.length !== 15 || LEGACY_ACTION_NAMES.length !== 15) {
    findings.push({ rule: "tools", severity: "hard_fail", message: "Canonical CLI catalog must contain exactly 15 one-to-one command/action bindings.", file: "src/commands/catalog.ts" });
  }

  const contractTests = walkFiles(context.root, "test/contract", file => file.endsWith(".ts"))
    .map(file => readText(context.root, file))
    .join("\n");
  for (const command of CLI_COMMAND_NAMES) {
    if (!contractTests.includes(`"${command}"`)) {
      findings.push({ rule: "tools", severity: "amend_required", message: `Contract tests do not reference CLI command ${command}.`, file: "test/contract" });
    }
  }
  return findings;
}
