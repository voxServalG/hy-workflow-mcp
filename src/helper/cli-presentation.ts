import type { HelperSkillOperationResult, HelperSkillStatus } from "./skills.js";
import {
  HELPER_CLI_SCHEMA,
  HELPER_CLI_VERSION,
  type HelperCliCommand,
  type HelperCliEnvelope,
  type HelperCliError,
  type HelperCliLayer,
} from "./cli-contract.js";

const OMITTED_ERROR_FIELDS = new Set([
  "display",
  "summary",
  "hint",
  "prompt",
  "instruction",
  "recovery",
]);

function sensitiveKey(key: string): boolean {
  return /(?:^|[_-])(?:token|secret|password|passwd|authorization|auth|api[_-]?key)(?:$|[_-])/i.test(key);
}

function factOnly(value: unknown, key = ""): unknown {
  if (sensitiveKey(key)) return value === undefined ? undefined : "[redacted]";
  if (key === "stdout" || key === "stderr" || key === "env" || key === "environment") {
    return value === undefined ? undefined : "[redacted]";
  }
  if (Array.isArray(value)) return value.map(item => factOnly(item));
  if (!value || typeof value !== "object") return value;
  const facts: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
    if (!OMITTED_ERROR_FIELDS.has(childKey)) facts[childKey] = factOnly(child, childKey);
  }
  return facts;
}

export function structuredError(error: unknown): HelperCliError {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const detail = record.detail === undefined ? undefined : factOnly(record.detail);
  return {
    type: typeof record.type === "string" ? record.type : "helper",
    subtype: typeof record.subtype === "string" ? record.subtype : "operation",
    code: typeof record.code === "string" ? record.code : "HELPER_OPERATION_FAILED",
    message: error instanceof Error ? error.message : String(error),
    retryable: record.retryable === true,
    ...(detail !== undefined ? { detail } : {}),
  };
}

export function skillLayer(result: HelperSkillOperationResult): HelperCliLayer {
  return {
    status: result.action,
    action: result.action,
    manifestSchema: result.manifest?.schemaVersion ?? null,
    bundleHash: result.manifest?.package.bundleHash ?? null,
    packageVersion: result.manifest?.package.version ?? null,
    skillCount: result.manifest?.skills.length ?? 0,
    targets: result.manifest?.targets.map(target => ({
      agent: target.agent,
      skillsDir: target.skillsDir,
      preference: target.preference,
    })) ?? [],
    findings: [],
  };
}

export function skillStatusLayer(status: HelperSkillStatus): HelperCliLayer {
  return {
    status: status.state,
    manifestSchema: status.manifest?.schemaVersion ?? null,
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

export function failedEnvelope(
  command: HelperCliCommand | null,
  clients: HelperCliEnvelope["clients"],
  error: unknown,
): HelperCliEnvelope {
  return {
    schema: HELPER_CLI_SCHEMA,
    version: HELPER_CLI_VERSION,
    command,
    ok: false,
    status: "failed",
    clients,
    skills: { status: "failed" },
    changedPaths: [],
    error: structuredError(error),
  };
}
