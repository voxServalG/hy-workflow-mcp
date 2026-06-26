import { isErrorSubtype, isErrorType, type ErrorSubtype, type ErrorType } from "./catalog.js";

export type StructuredError = {
  type: ErrorType;
  subtype: ErrorSubtype;
  message: string;
  detail?: unknown;
  cause?: string;
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

export function structuredError(input: unknown, fallbackType: ErrorType = "internal", fallbackSubtype: ErrorSubtype = "uncaught_exception"): StructuredError {
  if (isStructuredError(input)) return input;
  if (input && typeof input === "object") {
    const raw = input as Record<string, unknown>;
    const legacySubtype = isErrorSubtype(raw.subtype) ? raw.subtype : isErrorSubtype(raw.type) ? raw.type : fallbackSubtype;
    const subtype = legacySubtype as ErrorSubtype;
    const type = isErrorType(raw.type) ? raw.type : typeForSubtype(subtype, fallbackType);
    const message = typeof raw.message === "string" ? raw.message : JSON.stringify(raw);
    return { ...raw, type, subtype, message } as StructuredError;
  }
  const message = input instanceof Error ? input.message : String(input ?? "Unknown error");
  const subtype = subtypeForMessage(message, fallbackSubtype);
  return { type: typeForSubtype(subtype, fallbackType), subtype, message };
}

export function errorMessage(error: unknown): string {
  return isStructuredError(error) ? error.message : String(error ?? "");
}

