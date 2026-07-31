import type {
  ConfigCheckResult,
  JsonObject,
  RuntimeConfigAuthority,
} from "./config.js";

export const CONFIG_CLI_SCHEMA = "hy-workflow.config.v1" as const;
export const CONFIG_CLI_VERSION = 1 as const;

export type ConfigCliCommand = "check" | "apply" | "explain-policy";
export type ConfigCliStatus = "completed" | "attention" | "failed";

export type ConfigCliEnvelope = {
  schema: typeof CONFIG_CLI_SCHEMA;
  version: typeof CONFIG_CLI_VERSION;
  command: ConfigCliCommand;
  ok: boolean;
  status: ConfigCliStatus;
  project?: ConfigCheckResult["project"];
  authority?: RuntimeConfigAuthority;
  issues: string[];
  drift?: ConfigCheckResult["drift"];
  suggestion?: ConfigCheckResult["suggestion"];
  changed?: string[];
  preserved?: Record<string, string[]>;
  dryRun?: boolean;
  source?: string;
  candidate?: JsonObject;
  explanation?: unknown;
  error?: NonNullable<ConfigCheckResult["error"]>;
  recovery?: {
    strategy: "external_action";
    tool: "terminal";
    argv: string[];
  };
};

export function configResultEnvelope(
  command: "check" | "apply",
  result: ConfigCheckResult,
  recoveryArgv = result.recoveryArgv,
): ConfigCliEnvelope {
  return {
    schema: CONFIG_CLI_SCHEMA,
    version: CONFIG_CLI_VERSION,
    command,
    ok: result.ok,
    status: result.error ? "failed" : result.ok ? "completed" : "attention",
    project: result.project,
    issues: result.issues,
    drift: result.drift,
    suggestion: result.suggestion,
    ...(result.changed !== undefined ? { changed: result.changed } : {}),
    ...(result.preserved !== undefined ? { preserved: result.preserved } : {}),
    ...(result.dryRun !== undefined ? { dryRun: result.dryRun } : {}),
    ...(result.source !== undefined ? { source: result.source } : {}),
    ...(result.candidate !== undefined ? { candidate: result.candidate } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(!result.ok ? {
      recovery: {
        strategy: "external_action" as const,
        tool: "terminal" as const,
        argv: [...recoveryArgv],
      },
    } : {}),
  };
}

export function configPolicyEnvelope(
  authority: RuntimeConfigAuthority,
  issues: string[],
  explanation?: unknown,
): ConfigCliEnvelope {
  const ok = issues.length === 0;
  return {
    schema: CONFIG_CLI_SCHEMA,
    version: CONFIG_CLI_VERSION,
    command: "explain-policy",
    ok,
    status: ok ? "completed" : "failed",
    authority,
    issues,
    ...(ok ? { explanation } : {}),
  };
}
