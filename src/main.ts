#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runWorkflowCli, WORKFLOW_CLI_COMMANDS } from "./cli/workflow.js";
import { runConfigCli } from "./config.js";
import { runContractLint } from "./contralint/run.js";
import { runHelperCli } from "./helper/cli.js";
import { runSkillsCli } from "./skills/cli.js";
import { runLintCli } from "./lint.js";
import { PACKAGE_VERSION } from "./package-meta.js";

export function cliHelp(): string {
  return [
    "hy-workflow",
    "",
    "State and evidence CLI for the hy-workflow Skill bundle.",
    "",
    "Usage:",
    "  hy-workflow helper install|update|status|remove [options]",
    "  hy-workflow skills list|read [options]    Inspect packaged stage Skills",
    "  hy-workflow setup [options]               Alias for helper install",
    "  hy-workflow unset [--json]                 Alias for helper remove",
    "  hy-workflow <workflow-command> [--input <JSON>]",
    "  hy-workflow <workflow-command> --input-file <path>",
    "  hy-workflow lint --json                   Run built-in doclint and codelint",
    "  hy-workflow config ...                    Inspect or update project policy",
    "  hy-workflow doctor [--json]              Alias for helper status",
    "  hy-workflow --version",
    "",
    `Workflow commands: ${WORKFLOW_CLI_COMMANDS.join(", ")}`,
    "",
    "Workflow commands emit one hy-workflow.cli.v1 JSON document. The CLI is the",
    "sole authority for phase, stage, allowed actions, state, and verification evidence.",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(cliHelp() + "\n");
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(PACKAGE_VERSION + "\n");
    return 0;
  }
  if (argv[0] === "skills") {
    const result = runSkillsCli(argv.slice(1));
    process.stdout.write(result.stdout);
    return result.exitCode;
  }
  if (argv[0] === "helper" || argv[0] === "setup" || argv[0] === "unset") {
    const helperArgv = argv[0] === "helper"
      ? argv.slice(1)
      : [argv[0] === "setup" ? "install" : "remove", ...argv.slice(1)];
    const result = await runHelperCli(helperArgv);
    process.stdout.write(result.stdout);
    return result.exitCode;
  }
  if (argv[0] === "doctor") {
    const result = await runHelperCli(["status", ...argv.slice(1)]);
    process.stdout.write(result.stdout);
    return result.exitCode;
  }
  if (argv[0] === "config") {
    const result = runConfigCli(argv.slice(1));
    process.stdout.write(result.stdout);
    return result.exitCode;
  }
  if (argv[0] === "lint") {
    const result = await runLintCli(argv.slice(1));
    process.stdout.write(result.stdout);
    return result.exitCode;
  }
  if (argv[0] === "lint-contract") {
    const report = runContractLint(process.cwd());
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return report.ok ? 0 : 1;
  }
  const result = await runWorkflowCli(argv);
  process.stdout.write(result.stdout);
  return result.exitCode;
}

function isDirectEntrypoint(moduleUrl: string, argvEntry: string | undefined): boolean {
  if (!argvEntry) return false;
  try {
    return realpathSync.native(fileURLToPath(moduleUrl)) === realpathSync.native(resolve(argvEntry));
  } catch {
    return false;
  }
}

if (isDirectEntrypoint(import.meta.url, process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
