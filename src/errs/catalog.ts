export const ERROR_TYPES = [
  "validation",
  "workflow_state",
  "scope",
  "docs",
  "verification",
  "config",
  "io",
  "internal",
] as const;

export type ErrorType = typeof ERROR_TYPES[number];

export const ERROR_SUBTYPES = [
  "invalid_arguments",
  "invalid_plan",
  "invalid_command",
  "unknown_tool",
  "invalid_phase",
  "invalid_transition",
  "approval_missing",
  "scope_drift",
  "scope_amend_required",
  "docs_missing",
  "docs_stale",
  "sync_missing",
  "check_failed",
  "contract_failed",
  "setup_update_required",
  "setup_artifacts_missing",
  "harness_missing",
  "config_invalid",
  "artifact_tracked",
  "package_invalid",
  "io_failure",
  "uncaught_exception",
] as const;

export type ErrorSubtype = typeof ERROR_SUBTYPES[number];

export function isErrorType(value: unknown): value is ErrorType {
  return typeof value === "string" && (ERROR_TYPES as readonly string[]).includes(value);
}

export function isErrorSubtype(value: unknown): value is ErrorSubtype {
  return typeof value === "string" && (ERROR_SUBTYPES as readonly string[]).includes(value);
}

