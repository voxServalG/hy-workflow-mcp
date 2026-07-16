import { isErrorSubtype, isErrorType, type ErrorSubtype, type ErrorType } from "./catalog.js";

export type StructuredError = {
  type: ErrorType;
  subtype: ErrorSubtype;
  code?: string;
  message: string;
  hint?: string;
  detail?: unknown;
  cause?: string;
  retryable?: boolean;
  risk?: string | {
    level?: string;
    action?: string;
    impact?: string;
    [key: string]: unknown;
  };
  permission_violations?: Array<Record<string, unknown> | string>;
  missing_scopes?: string[];
  console_url?: string;
  request_id?: string;
  trace_id?: string;
  [key: string]: unknown;
};

function subtypeForMessage(message: string, fallback: ErrorSubtype): ErrorSubtype {
  const lower = message.toLowerCase();
  if (lower.includes("phase") || lower.includes("transition")) return "invalid_phase";
  if (lower.includes("scope")) return "scope_drift";
  if (lower.includes("document") || lower.includes("docs")) return "docs_missing";
  if (lower.includes("verify") || lower.includes("check")) return "check_failed";
  if (lower.includes("config")) return "config_invalid";
  if (lower.includes("unknown tool")) return "unknown_tool";
  return fallback;
}

function typeForSubtype(subtype: ErrorSubtype, fallback: ErrorType): ErrorType {
  if ([
    "preflight", "client_missing", "client_config", "client_shadowed", "binary_missing",
    "handshake", "lock_busy", "registry", "transaction", "postcondition",
    "artifact_drift", "identity", "ownership", "unset",
  ].includes(subtype)) return "setup";
  if (["invalid_phase", "invalid_transition", "approval_missing"].includes(subtype)) return "workflow_state";
  if (["scope_drift", "scope_amend_required"].includes(subtype)) return "scope";
  if (["docs_missing", "docs_stale", "sync_missing"].includes(subtype)) return "docs";
  if (["check_failed", "contract_failed"].includes(subtype)) return "verification";
  if (["setup_update_required", "setup_artifacts_missing", "harness_missing", "config_invalid", "artifact_tracked", "package_invalid"].includes(subtype)) return "config";
  if (subtype === "io_failure") return "io";
  if (["invalid_arguments", "invalid_plan", "invalid_command", "unknown_tool"].includes(subtype)) return "validation";
  return fallback;
}

export function isStructuredError(value: unknown): value is StructuredError {
  return Boolean(
    value &&
    typeof value === "object" &&
    isErrorType((value as any).type) &&
    isErrorSubtype((value as any).subtype) &&
    typeof (value as any).message === "string",
  );
}

function diagnosticRaw(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value === undefined ? undefined : "[redacted]";
  const raw = value as Record<string, unknown>;
  const safe: Record<string, unknown> = {};
  for (const key of ["startup_timeout_sec", "tool_timeout_sec", "sectionFingerprint", "entryFingerprint", "configMode"]) {
    if (raw[key] !== undefined) safe[key] = raw[key];
  }
  safe.keys = Object.keys(raw).sort();
  return safe;
}

function sensitiveKey(key: string): boolean {
  return /(?:^|[_-])(?:token|secret|password|passwd|authorization|auth|api[_-]?key)(?:$|[_-])/i.test(key);
}

function redactAssignments(value: string): string {
  return value
    .replace(/\b([A-Z][A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|AUTH|API[_-]?KEY)[A-Z0-9_-]*)\s*=\s*([^\s,;]+)/gi, "$1=[redacted]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]");
}

export function redactDiagnosticValue(value: unknown, key = ""): unknown {
  if (key === "raw" || key === "stdout" || key === "stderr") return diagnosticRaw(value);
  if (key === "env" || key === "environment") {
    return value && typeof value === "object" && !Array.isArray(value)
      ? { keys: Object.keys(value as Record<string, unknown>).sort() }
      : value === undefined ? undefined : "[redacted]";
  }
  if (sensitiveKey(key)) return value === undefined ? undefined : "[redacted]";
  if (Array.isArray(value)) return value.map(item => redactDiagnosticValue(item));
  if (typeof value === "string") return redactAssignments(value);
  if (!value || typeof value !== "object") return value;
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(input)) output[childKey] = redactDiagnosticValue(childValue, childKey);
  return output;
}

export function structuredError(input: unknown, fallbackType: ErrorType = "internal", fallbackSubtype: ErrorSubtype = "uncaught_exception"): StructuredError {
  if (isStructuredError(input)) {
    // Error.message is non-enumerable on native Error subclasses. Always return
    // a plain envelope so JSON output cannot silently drop the primary reason.
    return redactDiagnosticValue({ ...input, type: input.type, subtype: input.subtype, message: input.message }) as StructuredError;
  }
  if (input && typeof input === "object") {
    const raw = input as Record<string, unknown>;
    const legacySubtype = isErrorSubtype(raw.subtype) ? raw.subtype : isErrorSubtype(raw.type) ? raw.type : fallbackSubtype;
    const subtype = legacySubtype as ErrorSubtype;
    const type = isErrorType(raw.type) ? raw.type : typeForSubtype(subtype, fallbackType);
    const message = typeof raw.message === "string" ? raw.message : JSON.stringify(raw);
    return redactDiagnosticValue({ ...raw, type, subtype, message }) as StructuredError;
  }
  const message = input instanceof Error ? input.message : String(input ?? "Unknown error");
  const subtype = subtypeForMessage(message, fallbackSubtype);
  return { type: typeForSubtype(subtype, fallbackType), subtype, message };
}

export function errorMessage(error: unknown): string {
  return isStructuredError(error) ? error.message : String(error ?? "");
}
