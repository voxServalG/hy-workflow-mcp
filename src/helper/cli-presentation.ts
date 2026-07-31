import { redactDiagnosticValue } from "../errs/structured.js";
import type { HelperSkillOperationResult, HelperSkillStatus } from "./skills.js";
import type {
  HelperProjectReadiness,
  HelperProjectRegistration,
  HelperProjectStatus,
} from "./project.js";
import {
  HELPER_CLI_SCHEMA,
  HELPER_CLI_VERSION,
  helperCommandArgv,
  type HelperCliEnvelope,
  type HelperCliError,
  type HelperCliLayer,
  type ParsedHelperCli,
} from "./cli-contract.js";

const HELPER_ERROR_PRESENTATION_FIELDS = new Set([
  "display",
  "summary",
  "hint",
  "prompt",
  "instruction",
  "byLayer",
  "recovery",
]);

function factOnlyErrorDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(factOnlyErrorDetail);
  if (!value || typeof value !== "object") return value;
  const facts: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (!HELPER_ERROR_PRESENTATION_FIELDS.has(key)) facts[key] = factOnlyErrorDetail(child);
  }
  return facts;
}

export function structuredError(error: unknown): HelperCliError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const detail = record.detail === undefined ? undefined : factOnlyErrorDetail(record.detail);
  return redactDiagnosticValue({
    type: typeof record.type === "string" ? record.type : "helper",
    subtype: typeof record.subtype === "string" ? record.subtype : "operation",
    code: typeof record.code === "string" ? record.code : "HELPER_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: record.retryable === true,
    ...(detail !== undefined ? { detail } : {}),
  }) as HelperCliError;
}

export function notRunLayers(): HelperCliEnvelope["layers"] {
  return {
    skills: { status: "not_run" },
    project: { status: "not_run" },
    mcp: { status: "not_run" },
  };
}

export function skillLayer(result: HelperSkillOperationResult): HelperCliLayer {
  return {
    status: result.action,
    action: result.action,
    bundleHash: result.manifest?.package.bundleHash ?? null,
    packageVersion: result.manifest?.package.version ?? null,
    skillCount: result.manifest?.skills.length ?? 0,
    targets: result.manifest?.targets.map(target => ({
      agent: target.agent,
      skillsDir: target.skillsDir,
      preference: target.preference,
    })) ?? [],
    changedPaths: result.changes,
  };
}

export function skillStatusLayer(status: HelperSkillStatus): HelperCliLayer {
  return {
    status: status.state,
    bundleHash: status.bundleHash ?? status.manifest?.package.bundleHash ?? null,
    packageVersion: status.manifest?.package.version ?? null,
    skillCount: status.manifest?.skills.length ?? 0,
    targets: status.manifest?.targets.map(target => ({
      agent: target.agent,
      skillsDir: target.skillsDir,
      preference: target.preference,
    })) ?? [],
    findings: status.findings,
  };
}

export function projectLayer(result: HelperProjectRegistration | HelperProjectStatus): HelperCliLayer {
  const registration = "action" in result;
  return {
    status: registration ? result.action : result.state,
    projectId: result.projectId,
    configPath: result.configPath,
    deploymentPath: result.deploymentPath,
    registryPath: result.registryPath,
    workflowStatePath: result.workflowStatePath,
    scopePath: result.scopePath,
    configExists: result.readiness?.configExists
      ?? ("configExists" in result ? result.configExists : false),
    readiness: result.readiness,
    deploymentSchema: result.deployment?.schemaVersion ?? null,
    deploymentClients: result.deployment?.clients ?? [],
    projectFiles: result.deployment?.projectFiles ?? [],
    artifacts: result.deployment && "artifacts" in result.deployment ? result.deployment.artifacts : {},
    localFilesChanged: registration ? result.localFilesChanged : [],
    projectFilesChanged: [],
  };
}

export function completedLayerNames(layers: HelperCliEnvelope["layers"]): string[] {
  return Object.entries(layers)
    .filter(([, layer]) => !["not_run", "attention", "failed", "partial"].includes(layer.status))
    .map(([name]) => name);
}

export function partialEnvelope(
  parsed: ParsedHelperCli,
  root: string,
  clients: HelperCliEnvelope["clients"],
  layers: HelperCliEnvelope["layers"],
  error: unknown,
): HelperCliEnvelope {
  const facts = structuredError(error);
  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command: parsed.command,
    ok: false,
    status: completedLayerNames(layers).length ? "partial" : "failed",
    projectRoot: root,
    clients,
    layers,
    projectFilesChanged: [],
    error: facts,
    recovery: {
      command: parsed.command,
      argv: helperCommandArgv(parsed),
      completedLayers: completedLayerNames(layers),
      reason: facts.code,
    },
  };
}

function projectReadinessError(readiness: HelperProjectReadiness): HelperCliError {
  const first = readiness.issues[0];
  return {
    type: "helper",
    subtype: "project_readiness",
    code: first?.code ?? "HELPER_PROJECT_CONFIG_INVALID",
    message: first?.message ?? "The registered project is not ready for init.",
    retryable: false,
    detail: {
      configExists: readiness.configExists,
      authority: readiness.authority,
      issues: readiness.issues,
    },
  };
}

export function projectAttentionEnvelope(
  parsed: ParsedHelperCli,
  root: string,
  clients: HelperCliEnvelope["clients"],
  layers: HelperCliEnvelope["layers"],
  readiness: HelperProjectReadiness,
): HelperCliEnvelope {
  const error = projectReadinessError(readiness);
  const identityRecovery = error.code === "HELPER_PROJECT_IDENTITY_RECONCILIATION_REQUIRED";
  const recoveryCommand: ParsedHelperCli["command"] = identityRecovery ? "install" : parsed.command;
  const recoveryArgv = identityRecovery ? ["hy-workflow", "helper", "install", "--json"] : helperCommandArgv(parsed);
  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command: parsed.command,
    ok: false,
    status: "attention",
    projectRoot: root,
    clients,
    layers,
    projectFilesChanged: [],
    error,
    recovery: {
      command: recoveryCommand,
      argv: recoveryArgv,
      completedLayers: completedLayerNames(layers),
      reason: error.code,
    },
  };
}
