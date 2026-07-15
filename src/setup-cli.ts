import type { ClientName } from "./runtime/deployment.js";
import { detectClients, executeSetup } from "./setup/operations.js";
import { finishPrompt, promptSetupOptions } from "./setup/prompts.js";
import type { SetupAction, SetupLanguage, SetupOptions } from "./setup/types.js";

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
    } else if (arg === "--language") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        if (value !== "zh" && value !== "en") parsed.errors.push(`Invalid --language value: ${value}`);
        else parsed.options.language = value as SetupLanguage;
      }
    } else if (arg === "--action") {
      const value = take(i, arg);
      if (value !== null) {
        i += 1;
        if (value !== "setup" && value !== "unset") parsed.errors.push(`Invalid --action value: ${value}`);
        else parsed.options.action = value;
      }
    } else parsed.errors.push(`Unknown option: ${arg}`);
  }
  return parsed;
}

function emitError(message: string, json: boolean): void {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }, null, 2) + "\n");
  else process.stderr.write(`hy-workflow setup: ${message}\n`);
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
    emitError(parsed.errors.join("; "), parsed.options.json);
    return 1;
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !parsed.options.yes);
  let options = parsed.options;
  if (interactive) {
    const prompted = await promptSetupOptions(invokedAction, detectClients());
    if (!prompted) return 0;
    options = { ...prompted, dryRun: parsed.options.dryRun, json: parsed.options.json };
  } else if (!parsed.options.yes || !parsed.explicitClients) {
    emitError("non-interactive use requires --yes and --clients <list|all>", parsed.options.json);
    return 1;
  }

  try {
    const result = await executeSetup(root, options);
    if (options.json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    else if (interactive) finishPrompt(result.message);
    else process.stdout.write(result.message + "\n");
    return result.ok ? 0 : 1;
  } catch (error: any) {
    emitError(error?.message ?? String(error), options.json);
    return 1;
  }
}
