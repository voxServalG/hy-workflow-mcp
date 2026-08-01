#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseInputOptions } from "./cli/input.js";
import { issueFromError, jsonLine } from "./cli/output.js";
import { runHelperCli } from "./helper/cli.js";
import { runHelperTui } from "./helper/tui.js";
import { PACKAGE_VERSION } from "./package-meta.js";
import { inspectRepository } from "./protocol/inspect.js";
import { verifyEvidence } from "./protocol/verify.js";

export function helperHelp(): string {
  return [
    "hy-workflow helper",
    "",
    "Interactive Skill installer and ownership checker for Codex, Claude, and OpenCode.",
    "",
    "Usage:",
    "  hy-workflow helper                         Launch TUI in an interactive terminal",
    "  hy-workflow helper install [--clients all|LIST] [--mode auto|symlink|copy] [--json]",
    "  hy-workflow helper update [--repair] [--json]",
    "  hy-workflow helper status [--json]",
    "  hy-workflow helper remove [--json]",
    "  hy-workflow helper -h|--help",
    "",
    "The helper writes only owned user-level Skill resources. --json keeps the stable machine contract.",
  ].join("\n");
}

export function cliHelp(): string {
  return [
    "hy-workflow",
    "",
    "Git-native incident and invariant evidence protocol for coding Agents.",
    "",
    "Usage:",
    "  hy-workflow helper install|update|status|remove [--json]",
    "  hy-workflow inspect --json",
    "  hy-workflow verify --input-file <evidence.json> --json",
    "  hy-workflow verify --input '<JSON object>' --json",
    "  hy-workflow --version",
    "",
    "inspect reads the tracked root hy-workflow.yml and the current Git diff,",
    "then issues exact project-native argv. verify checks agent-attested results",
    "against the current protocol, HEAD, diff, argv, and expected exit codes.",
    "Neither command grants or denies permission for an Agent to continue working.",
  ].join("\n");
}

function errorOutput(command: string | null, error: unknown): string {
  return jsonLine({
    schema: "hy-workflow.error.v1",
    version: 1,
    command,
    ok: false,
    status: "invalid",
    issues: [issueFromError(error)],
  });
}

function inspectOptions(argv: readonly string[]): void {
  const unknown = argv.filter(argument => argument !== "--json");
  if (unknown.length) {
    const error = new Error(`inspect accepts only --json; unknown option: ${unknown[0]}.`);
    (error as Error & { code: string }).code = "OPTION_UNKNOWN";
    throw error;
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(`${cliHelp()}\n`);
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${PACKAGE_VERSION}\n`);
    return 0;
  }
  if (argv[0] === "helper") {
    const helperArgs = argv.slice(1);
    if (helperArgs[0] === "--help" || helperArgs[0] === "-h") {
      process.stdout.write(`${helperHelp()}\n`);
      return 0;
    }
    if (!helperArgs.length) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stdout.write(`${helperHelp()}\n`);
        return 0;
      }
      return runHelperTui();
    }
    const result = await runHelperCli(helperArgs);
    process.stdout.write(result.stdout);
    return result.exitCode;
  }
  if (argv[0] === "inspect") {
    try {
      inspectOptions(argv.slice(1));
      const result = inspectRepository();
      process.stdout.write(jsonLine(result));
      return result.status === "invalid" ? 1 : 0;
    } catch (error) {
      process.stdout.write(errorOutput("inspect", error));
      return 1;
    }
  }
  if (argv[0] === "verify") {
    try {
      const input = parseInputOptions(argv.slice(1));
      const result = verifyEvidence(input);
      process.stdout.write(jsonLine(result));
      return result.status === "verified" ? 0 : 1;
    } catch (error) {
      process.stdout.write(errorOutput("verify", error));
      return 1;
    }
  }
  process.stdout.write(errorOutput(argv[0] ?? null, Object.assign(
    new Error(`Unknown command: ${argv[0]}. Use --help for the supported thin interface.`),
    { code: "COMMAND_UNKNOWN" },
  )));
  return 1;
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
    process.stdout.write(errorOutput(null, error));
    process.exitCode = 1;
  });
}
