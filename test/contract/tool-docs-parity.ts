import { existsSync, readFileSync } from "node:fs";
import {
  CLI_COMMAND_NAMES,
  COMMAND_CONTRACTS,
  LEGACY_ACTION_NAMES,
  assertCommandCatalogMatchesCli,
} from "../../src/commands/catalog.js";
import { WORKFLOW_CLI_COMMANDS } from "../../src/cli/workflow.js";

const EXPECTED_CLI_COMMANDS = [
  "init",
  "status",
  "read-docs",
  "plan",
  "approve",
  "branch",
  "edit",
  "sync-docs",
  "verify",
  "exam-plan",
  "exam-submit",
  "amend-plan",
  "commit",
  "merge",
  "reset",
] as const;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assertCommandCatalogMatchesCli(WORKFLOW_CLI_COMMANDS);
assert(
  JSON.stringify([...CLI_COMMAND_NAMES].sort()) === JSON.stringify([...EXPECTED_CLI_COMMANDS].sort()),
  "literal CLI command list drifted from the canonical catalog",
);
assert(COMMAND_CONTRACTS.length === 15 && new Set(LEGACY_ACTION_NAMES).size === 15, "CLI commands must keep 15 unique one-to-one legacy kernel actions");
assert(!existsSync("src/server.ts"), "removed MCP server source must not exist");

const cli = readFileSync("src/cli/workflow.ts", "utf-8");
const main = readFileSync("src/main.ts", "utf-8");
for (const contract of COMMAND_CONTRACTS) {
  assert(existsSync(contract.handlerFile), `missing handler for ${contract.command}: ${contract.handlerFile}`);
  const handlerImport = contract.handlerFile.replace(/^src\//, "../").replace(/\.ts$/, ".js");
  assert(cli.includes(handlerImport), `CLI adapter missing handler import for ${contract.command}`);
  assert(cli.includes(`tool: "${contract.legacyAction}"`), `CLI adapter missing legacy kernel binding for ${contract.command}`);
  assert(contract.phases.length > 0 && contract.stages.length > 0, `${contract.command} must declare phase/stage ownership`);
}
for (const token of ["runWorkflowCli", "WORKFLOW_CLI_COMMANDS", "hy-workflow.cli.v1"]) {
  assert(main.includes(token) || cli.includes(token), `public CLI surface missing ${token}`);
}
for (const forbidden of ["@modelcontextprotocol/sdk", "StdioServerTransport", "new Server(", "server.connect("]) {
  assert(!main.includes(forbidden) && !cli.includes(forbidden), `public CLI source must not start MCP: ${forbidden}`);
}

console.log("tool-docs-parity: 15 CLI commands, handlers, legacy kernel mapping, and no-MCP entrypoint pass");
