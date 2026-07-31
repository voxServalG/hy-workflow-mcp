import type { ClientName } from "./runtime/deployment.js";
import { defaultSuggestion, ensureConfigDefaults, withConfirmedCiCommands, type JsonObject } from "./config.js";
import { structuredError } from "./errs/structured.js";
import { findProjectRoot } from "./runtime/project.js";
import { createClientAdapters, detectClients, executeSetup } from "./setup/operations.js";
import { existingSharedProjectFiles, previewArtifactChanges } from "./setup/preflight.js";
import { beginSetupPrompt, detectWithPrompt, finishPrompt, promptSetupOptions, runWithSpinner, successMessage, failureMessage } from "./setup/prompts.js";
import { SetupFailure, type SetupAction, type SetupFailureResult, type SetupLanguage, type SetupOptions } from "./setup/types.js";
import { projectReadinessIssues } from "./tools/init.js";
import { MINIMAL_PROJECT_CONTRACT, readDeployment } from "./runtime/deployment.js";

const CLIENTS: ClientName[] = ["codex", "claude", "opencode"];

type Parsed = {
  help: boolean;
  options: SetupOptions;
  explicitClients: boolean;
  errors: string[];
};

function parseClients(raw: string): ClientName[] | null {
  const values = raw === "all" ? CLIENTS : raw.split(",").map(value => value.trim()).filter(Boolean);
  if (values.some(value => !CLIENTS.includes(value as ClientName))) return null;
  return [...new Set(values)] as ClientName[];
}

export function setupHelp(): string {
  return [
    "hy-workflow setup",
    "",
    "Usage:",
    "  hy-workflow setup                         Interactive install/update/unset TUI",
    "  hy-workflow unset                         Interactive project removal",
    "  hy-workflow setup --yes --clients codex,claude,opencode [--json]",
    "  hy-workflow unset --yes --clients all [--remove-global] [--json]",
    "",
    "Options:",
    "  --clients <list|all>  Explicit client selection for non-interactive use",
    "  --remove-global       On final unset, remove MCP entries owned by hy-workflow",
    "  --sync-project-artifacts  Independently replace occupied project integration files",
    "  --accept-artifact-changes  Allow reviewed team-artifact diffs to be applied",
    "  --review-artifact <file>:<before|absent>:<after>  Bind one reviewed SHA-256 diff; repeat as needed",
    "  --ci-command <cmd>    Explicit confirmed CI command; repeat for multiple commands",
    "  --project-id <id>     Recover/unset a specific registered project identity",
    "  --yes                 Non-interactive mode; requires --clients",
    "  --dry-run             Report changes without writing",
    "  --json                Emit one JSON result",
    "  --language <zh|en>    Output language",
    "  -h, --help            Show help",
  ].join("\n");
}

export function parseSetupArgs(argv: string[], invokedAction: SetupAction): Parsed {
  const parsed: Parsed = {
    help: false,
    explicitClients: false,
    errors: [],
    options: {
      action: invokedAction,
      mode: "shared",
      clients: [],
      language: "zh",
      yes: false,
      dryRun: false,
      json: false,
      removeGlobal: false,
    },
  };
  const take = (index: number, flag: string): string | null => {
    const value = argv[index + 1];
    if (!value || value.startsWith("-")) {
      parsed.errors.push(`Missing value for ${flag}`);
      return null;
    }
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--yes" || arg === "-y") parsed.options.yes = true;
    else if (arg === "--dry-run") parsed.options.dryRun = true;
    else if (arg === "--json") parsed.options.json = true;
    else if (arg === "--local") parsed.errors.push("--local has been removed; setup always writes hy-workflow.json and .github/workflows/hy-workflow.yml");
    else if (arg === "--shared") parsed.options.mode = "shared";
    else if (arg === "--remove-global") parsed.options.removeGlobal = true;
    else if (arg === "--keep-global") parsed.options.removeGlobal = false;
    else if (arg === "--sync-project-artifacts") parsed.options.syncProjectArtifacts = true;
    else if (arg === "--accept-artifact-changes") parsed.options.acceptArtifactChanges = true;
    else if (arg === "--review-artifact") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        const match = /^([^:]+):(absent|[a-f0-9]{64}):([a-f0-9]{64})$/.exec(value);
        if (!match) parsed.errors.push(`Invalid --review-artifact value: ${value}`);
        else {
          parsed.options.reviewedArtifactChanges ??= [];
          parsed.options.reviewedArtifactChanges.push({ file: match[1], beforeHash: match[2] === "absent" ? null : match[2], afterHash: match[3] });
        }
      }
    }
    else if (arg === "--accept-ci-commands") parsed.options.acceptCiCommands = true;
    else if (arg === "--force-client-overwrite") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        const clients = parseClients(value);
        if (!clients?.length) parsed.errors.push(`Invalid --force-client-overwrite value: ${value}`);
        else parsed.options.forceClientOverwrite = clients;
      }
    }
    else if (arg === "--migrate-legacy-clients") parsed.options.migrateLegacyClients = true;
    else if (arg === "--clients") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        const clients = parseClients(value);
        if (!clients?.length) parsed.errors.push(`Invalid --clients value: ${value}`);
        else {
          parsed.options.clients = clients;
          parsed.explicitClients = true;
        }
      }
    } else if (arg === "--ci-command") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        parsed.options.ciCommands ??= [];
        parsed.options.ciCommands.push(value);
      }
    } else if (arg === "--project-id") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        if (!/^[a-f0-9]{24}$/i.test(value)) parsed.errors.push(`Invalid --project-id value: ${value}`);
        else parsed.options.projectId = value.toLowerCase();
      }
    } else if (arg === "--language") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        if (value !== "zh" && value !== "en") parsed.errors.push(`Invalid --language value: ${value}`);
        else parsed.options.language = value as SetupLanguage;
      }
    } else if (arg === "--action") {
      const value = take(i, arg);
      if (value !== null) i += 1;
      parsed.errors.push("--action is not supported; the setup or unset subcommand determines the operation");
    } else parsed.errors.push(`Unknown option: ${arg}`);
  }
  return parsed;
}

function failureResult(error: unknown, action: SetupAction, argv: string[]): SetupFailureResult {
  const detail = structuredError(error, "setup", "preflight");
  const stage = action === "setup" ? "setup.apply" : "setup.unset";
  const retryArgv = [action, ...argv];
  const command = ["hy-workflow", ...retryArgv].map(value => JSON.stringify(value)).join(" ");
  const instruction = detail.hint ?? `Review ${detail.code ?? detail.subtype}, correct the input or environment, then retry ${command}.`;
  const retryable = detail.retryable === true;
  return {
    ok: false,
    phase: "setup",
    action,
    stage,
    status: "failed",
    nextAction: { tool: "hy-workflow", arguments: { argv: retryArgv }, phase: "setup", stage, automatic: false },
    control: { automatic: false, stop: true, reason: retryable ? "wait_required" : "repair_required" },
    userAction: { kind: retryable ? "wait" : "review_failure", instruction },
    recovery: retryable
      ? { strategy: "wait_and_retry", tool: "hy-workflow", arguments: { argv: retryArgv }, command, instruction }
      : { strategy: "repair_and_retry", tool: "hy-workflow", arguments: { argv: retryArgv }, command, instruction },
    error: detail,
  };
}

function emitError(error: unknown, json: boolean, action: SetupAction, argv: string[]): void {
  const result = failureResult(error, action, argv);
  const detail = result.error;
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else process.stderr.write(`hy-workflow setup: ${detail.message}${detail.hint ? `\n${detail.hint}` : ""}\n`);
}

export async function runSetupCli(
  argv: string[] = [],
  invokedAction: SetupAction = "setup",
  root = process.cwd(),
): Promise<number> {
  const parsed = parseSetupArgs(argv, invokedAction);
  if (parsed.help) {
    process.stdout.write(setupHelp() + "\n");
    return parsed.errors.length ? 1 : 0;
  }
  if (parsed.errors.length) {
    emitError({ type: "validation", subtype: "invalid_arguments", code: "CLI_USAGE", message: parsed.errors.join("; "), retryable: false }, parsed.options.json, invokedAction, argv);
    return 1;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !parsed.options.yes);
  let options = parsed.options;
  try {
    const projectRoot = findProjectRoot(root);
    const deployment = readDeployment(projectRoot);
    const legacyInert = Boolean(deployment && !(deployment.schemaVersion === "3" && deployment.projectContract === MINIMAL_PROJECT_CONTRACT));
    const orphanProjectArtifacts = !deployment && existingSharedProjectFiles(projectRoot).length > 0;
    const projectArtifactsInert = legacyInert || orphanProjectArtifacts;
    const adapters = createClientAdapters(projectRoot);
    if (interactive) {
      beginSetupPrompt();
      const context = detectWithPrompt(() => {
        const detections = detectClients(adapters);
        if (legacyInert) {
          return {
            detections,
            candidate: undefined,
            ciCandidates: [],
            hasCiCommands: true,
            readinessIssues: [],
          };
        }
        const configResult = ensureConfigDefaults(projectRoot, { dryRun: true });
        const candidate = configResult.candidate as JsonObject | undefined;
        const ciCandidates = defaultSuggestion(projectRoot).ciCommands;
        const currentCi = (candidate?.ci as any)?.commands;
        const hasCiCommands = Array.isArray(currentCi) && currentCi.length > 0;
        let readinessIssues: Array<{ code: string; message: string; recovery: string }> = [];
        if (!configResult.ok) {
          const messages = configResult.issues.length
            ? configResult.issues
            : [configResult.display.body];
          readinessIssues = messages.map(message => ({
            code: "SETUP_CONFIG_CONFIRMATION_REQUIRED",
            message,
            recovery: configResult.suggestedCommand || configResult.hint,
          }));
        } else if (candidate) {
          try { readinessIssues = projectReadinessIssues(projectRoot, candidate, { forSetup: true }); }
          catch (error: any) { readinessIssues = [{ code: "SETUP_PREFLIGHT_FAILED", message: error?.message ?? String(error), recovery: configResult.hint }]; }
        } else readinessIssues = [{ code: "SETUP_PREFLIGHT_FAILED", message: configResult.display.body, recovery: configResult.hint }];
        return { detections, candidate, ciCandidates, hasCiCommands, readinessIssues };
      });
      const prompted = await promptSetupOptions(invokedAction, context.detections, {
        introShown: true,
        ciCandidates: context.ciCandidates,
        hasCiCommands: context.hasCiCommands,
        readinessIssues: context.readinessIssues,
        artifactChangesForCi: commands => {
          if (projectArtifactsInert || !context.candidate) return [];
          const config = commands?.length && !context.hasCiCommands
            ? withConfirmedCiCommands(context.candidate, commands)
            : context.candidate;
          return previewArtifactChanges(projectRoot, config);
        },
      });
      if (!prompted) return 0;
      // Merge CLI-provided compatibility flags into the TUI-driven options.
      // migrateLegacyClients is intentionally a no-op: project injections stay unread and untouched.
      options = {
        ...prompted,
        dryRun: parsed.options.dryRun,
        json: parsed.options.json,
        forceClientOverwrite: parsed.options.forceClientOverwrite ?? prompted.forceClientOverwrite,
        migrateLegacyClients: parsed.options.migrateLegacyClients ?? prompted.migrateLegacyClients,
        syncProjectArtifacts: parsed.options.syncProjectArtifacts,
        acceptArtifactChanges: parsed.options.acceptArtifactChanges,
        reviewedArtifactChanges: parsed.options.reviewedArtifactChanges,
      };
    } else if (!parsed.options.yes || !parsed.explicitClients) {
      emitError({ type: "validation", subtype: "invalid_arguments", code: "CLI_USAGE", message: "non-interactive use requires --yes and --clients <list|all>", retryable: false }, parsed.options.json, invokedAction, argv);
      return 1;
    }
    if (!interactive && options.action === "setup") {
      if (!legacyInert && options.acceptCiCommands && !options.ciCommands?.length) {
        throw new SetupFailure(
          "preflight",
          "SETUP_PREFLIGHT_FAILED",
          "Non-interactive CI approval requires the exact reviewed commands.",
          "Pass each reviewed command with --ci-command, or use the interactive TUI. A bare --accept-ci-commands flag cannot approve inferred values.",
        );
      }
      if (!legacyInert && options.syncProjectArtifacts && (!options.acceptArtifactChanges || !options.reviewedArtifactChanges?.length)) {
        throw new SetupFailure(
          "artifact_drift",
          "SETUP_ARTIFACT_REVIEW_INCOMPLETE",
          "Explicit project artifact sync requires acceptance and complete exact review tuples.",
          "Use --sync-project-artifacts together with --accept-artifact-changes and one --review-artifact tuple for every occupied integration target. Ordinary setup is a separate operation and leaves those files untouched.",
          { occupiedTargets: orphanProjectArtifacts ? existingSharedProjectFiles(projectRoot).sort() : [] },
        );
      }
    }
    if (!interactive && options.dryRun && options.json) {
      const result = await executeSetup(projectRoot, options, adapters, { inspectDirectTools: true });
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return result.ok ? 0 : 1;
    }
    let result;
    if (interactive) {
      const applyingCopy = options.language === "en"
        ? { in: "Writing configuration and updating clients…", done: "Configuration applied" }
        : { in: "正在写入配置并更新客户端…", done: "配置完成" };
      result = await runWithSpinner(
        applyingCopy.in,
        applyingCopy.done,
        () => executeSetup(projectRoot, options, adapters, { inspectDirectTools: true }),
      );
    } else {
      result = await executeSetup(projectRoot, options, adapters, { inspectDirectTools: true });
    }
    if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (interactive) finishPrompt(result.ok ? successMessage(options.action, result.projectFilesChanged, options.language) : failureMessage(options.language));
    else process.stdout.write((result.ok ? successMessage(options.action, result.projectFilesChanged, options.language) : result.message) + "\n");
    return result.ok ? 0 : 1;
  } catch (error: any) {
    emitError(error instanceof Error ? error : new SetupFailure("preflight", "SETUP_PREFLIGHT_FAILED", String(error)), options.json, invokedAction, argv);
    return 1;
  }
}
