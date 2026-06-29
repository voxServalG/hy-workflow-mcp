import { structuredError } from "../../src/errs/structured.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const full = structuredError({
  type: "validation",
  subtype: "invalid_arguments",
  code: "ARG_MISSING",
  message: "Missing branch topic",
  hint: "Pass category and topic",
  detail: { field: "topic" },
  cause: "empty string",
  retryable: true,
  risk: { level: "low", action: "retry" },
  permission_violations: ["write:/repo"],
  missing_scopes: ["repo:write"],
  console_url: "https://example.test/console",
  request_id: "req-1",
  trace_id: "trace-1",
});
assert(full.type === "validation", "type should survive");
assert(full.subtype === "invalid_arguments", "subtype should survive");
assert(full.code === "ARG_MISSING", "code should survive");
assert(full.hint === "Pass category and topic", "hint should survive");
assert((full.detail as any).field === "topic", "detail should survive");
assert(full.cause === "empty string", "cause should survive");
assert(full.retryable === true, "retryable should survive");
assert((full.risk as any).level === "low", "risk should survive");
assert(full.permission_violations?.[0] === "write:/repo", "permission violations should survive");
assert(full.missing_scopes?.[0] === "repo:write", "missing scopes should survive");
assert(full.console_url?.includes("console"), "console_url should survive");
assert(full.request_id === "req-1", "request_id should survive");
assert(full.trace_id === "trace-1", "trace_id should survive");

const legacySubtype = structuredError({ type: "scope_drift", message: "scope changed" });
assert(legacySubtype.type === "scope", "legacy subtype in type field should infer type");
assert(legacySubtype.subtype === "scope_drift", "legacy subtype should be preserved");

const stringError = structuredError("verify check failed");
assert(stringError.type === "verification", "string verify errors should classify as verification");
assert(stringError.subtype === "check_failed", "string verify errors should classify as check_failed");
assert(stringError.message === "verify check failed", "string error message should survive");
