import type { ClientName } from "../runtime/deployment.js";
import type { RetiredWorkflowMcpResult } from "../setup/operations.js";
import type { ClientAdapter } from "../setup/types.js";
import type {
  DetectedHelperSkillTarget,
  HelperSkillFaultHooks,
  HelperSkillPaths,
  HelperSkillProjectionPreference,
} from "./skills.js";
import type {
  HelperProjectRegistration,
  HelperProjectStatus,
} from "./project.js";

export const HELPER_CLI_SCHEMA = "hy-workflow.helper.v1" as const;
export const HELPER_CLI_VERSION = 1 as const;
export const HELPER_CLI_COMMANDS = ["install", "update", "status", "remove"] as const;
export const HELPER_CLI_CLIENTS = ["codex", "claude", "opencode"] as const;

export type HelperCliCommand = typeof HELPER_CLI_COMMANDS[number];

export type ParsedHelperCli = {
  command: HelperCliCommand;
  clients: ClientName[] | null;
  mode: HelperSkillProjectionPreference | null;
  repair: boolean;
  json: boolean;
  argv: string[];
};

export type HelperCliError = {
  type: string;
  subtype: string;
  code: string;
  message: string;
  retryable: boolean;
  detail?: unknown;
};

export type HelperCliLayer = {
  status: string;
  [key: string]: unknown;
};

export type HelperCliEnvelope = {
  schema: typeof HELPER_CLI_SCHEMA;
  version: typeof HELPER_CLI_VERSION;
  command: HelperCliCommand | null;
  ok: boolean;
  status: "completed" | "attention" | "partial" | "failed";
  projectRoot: string | null;
  clients: ClientName[];
  layers: {
    skills: HelperCliLayer;
    project: HelperCliLayer;
    mcp: HelperCliLayer;
  };
  projectFilesChanged: [];
  error?: HelperCliError;
  recovery?: {
    command: HelperCliCommand;
    argv: string[];
    completedLayers: string[];
    reason: string;
  };
};

export type HelperCliRunResult = {
  exitCode: 0 | 1;
  stdout: string;
  envelope: HelperCliEnvelope;
};

export type HelperCliDependencies = {
  cwd?: string;
  bundleRoot?: string;
  skillPaths?: HelperSkillPaths;
  detectedTargets?: DetectedHelperSkillTarget[];
  skillHooks?: HelperSkillFaultHooks;
  adapters?: ClientAdapter[];
  registerProject?: (root: string, clients: ClientName[]) => Promise<HelperProjectRegistration>;
  projectStatus?: (root: string) => HelperProjectStatus;
  retireWorkflowMcp?: (
    root: string,
    clients: ClientName[],
    adapters?: ClientAdapter[],
  ) => Promise<RetiredWorkflowMcpResult>;
};

export class HelperCliInputError extends Error {
  readonly type = "validation" as const;
  readonly subtype = "invalid_arguments" as const;
  readonly retryable = false;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "HelperCliInputError";
  }
}

export function isHelperCliCommand(value: string): value is HelperCliCommand {
  return (HELPER_CLI_COMMANDS as readonly string[]).includes(value);
}

function parseClients(value: string): ClientName[] {
  if (value === "all") return [...HELPER_CLI_CLIENTS];
  if (!value || value.trim() !== value || /\s/.test(value)) {
    throw new HelperCliInputError("HELPER_CLIENTS_INVALID", "--clients must be all or a comma-separated client list without whitespace.");
  }
  const values = value.split(",");
  if (!values.length || values.some(client => !(HELPER_CLI_CLIENTS as readonly string[]).includes(client))) {
    throw new HelperCliInputError("HELPER_CLIENTS_INVALID", `Unsupported --clients value: ${value}.`);
  }
  if (new Set(values).size !== values.length) {
    throw new HelperCliInputError("HELPER_CLIENTS_INVALID", "--clients must not contain duplicates.");
  }
  return HELPER_CLI_CLIENTS.filter(client => values.includes(client));
}

export function parseHelperCliArgs(argv: readonly string[]): ParsedHelperCli {
  const rawCommand = argv[0];
  if (!rawCommand) throw new HelperCliInputError("HELPER_COMMAND_MISSING", "A helper command is required.");
  if (!isHelperCliCommand(rawCommand)) throw new HelperCliInputError("HELPER_COMMAND_UNKNOWN", `Unknown helper command: ${rawCommand}.`);

  let clients: ClientName[] | null = null;
  let mode: HelperSkillProjectionPreference | null = null;
  let repair = false;
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--json" || option === "--repair") {
      if (option === "--json") {
        if (json) throw new HelperCliInputError("HELPER_OPTION_REPEATED", "--json may be provided only once.");
        json = true;
      } else {
        if (repair) throw new HelperCliInputError("HELPER_OPTION_REPEATED", "--repair may be provided only once.");
        repair = true;
      }
      continue;
    }
    if (option !== "--clients" && option !== "--mode") {
      throw new HelperCliInputError("HELPER_OPTION_UNKNOWN", `Unknown ${rawCommand} option: ${option}.`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new HelperCliInputError("HELPER_OPTION_VALUE_MISSING", `${option} requires one value.`);
    }
    if (option === "--clients") {
      if (clients) throw new HelperCliInputError("HELPER_OPTION_REPEATED", "--clients may be provided only once.");
      clients = parseClients(value);
    } else {
      if (mode) throw new HelperCliInputError("HELPER_OPTION_REPEATED", "--mode may be provided only once.");
      if (!(["auto", "symlink", "copy"] as string[]).includes(value)) {
        throw new HelperCliInputError("HELPER_MODE_INVALID", "--mode must be auto, symlink, or copy.");
      }
      mode = value as HelperSkillProjectionPreference;
    }
    index += 1;
  }

  const allowed: Record<HelperCliCommand, Set<string>> = {
    install: new Set(["clients", "mode", "json"]),
    update: new Set(["clients", "mode", "repair", "json"]),
    status: new Set(["json"]),
    remove: new Set(["json"]),
  };
  const used = [clients ? "clients" : null, mode ? "mode" : null, repair ? "repair" : null, json ? "json" : null].filter((value): value is string => Boolean(value));
  const invalid = used.filter(option => !allowed[rawCommand].has(option));
  if (invalid.length) {
    throw new HelperCliInputError("HELPER_OPTION_NOT_ALLOWED", `${rawCommand} does not accept: ${invalid.map(option => `--${option}`).join(", ")}.`);
  }
  return { command: rawCommand, clients, mode, repair, json, argv: [...argv] };
}

export function helperCommandArgv(parsed: ParsedHelperCli): string[] {
  const argv = ["hy-workflow", "helper", parsed.command];
  if (parsed.clients) argv.push("--clients", parsed.clients.join(","));
  if (parsed.mode) argv.push("--mode", parsed.mode);
  if (parsed.repair) argv.push("--repair");
  if (parsed.json) argv.push("--json");
  return argv;
}
