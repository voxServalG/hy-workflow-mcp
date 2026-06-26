import { toolResult } from "../../src/output/envelope.js";
import { ERROR_ENVELOPE_FIELDS, OUTPUT_CONTROL_FIELDS } from "../../src/output/contract.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

for (const field of ["status", "data", "error", "summary", "checks", "findings", "pagination", "meta", "_notice"]) {
  assert((OUTPUT_CONTROL_FIELDS as readonly string[]).includes(field), `output contract should include ${field}`);
}
for (const field of ["code", "hint", "retryable", "risk", "permission_violations", "missing_scopes", "console_url", "request_id", "trace_id"]) {
  assert((ERROR_ENVELOPE_FIELDS as readonly string[]).includes(field), `error contract should include ${field}`);
}

const ok = toolResult("plan", {
  status: "ready",
  data: { id: "plan-1" },
  display: { title: "ok", files: ["docs/output.md"], urls: ["https://example.test"] },
  summary: "review this plan",
  hint: "wait for approve",
  requires_user: true,
  stop_here: true,
  allowedTools: ["hy_approve"],
  blockedTools: ["hy_commit"],
  recovery: { tool: "hy_plan", command: "npm run lint:contract", instruction: "fix contract drift", byLayer: { lint: "sync docs" } },
  checks: [{ name: "contract", status: "passed" }],
  findings: [],
  pagination: { has_more: true, page_token: "p1", next_page_token: "p2" },
  meta: { command: "hy_plan", cwd: process.cwd(), identity: "agent", format: "json", version: "1", request_id: "req-1", trace_id: "trace-1", duration_ms: 12 },
  _notice: { update: { message: "current", command: "npm update", current_version: "1.0.0", latest_version: "1.0.1" } },
});
assert(ok.ok === true, "success envelope should be ok");
assert(ok.phase === "plan" && ok.next === "plan", "success envelope should include phase and next");
assert(ok.status === "ready", "status should survive normalization");
assert((ok.data as any).id === "plan-1", "data should survive normalization");
assert(ok.summary === "review this plan", "summary should survive normalization");
assert(ok.recovery?.command === "npm run lint:contract", "recovery.command should survive normalization");
assert(ok.pagination?.next_page_token === "p2", "pagination should survive normalization");
assert(ok.meta?.request_id === "req-1", "meta request_id should survive normalization");
assert(ok._notice?.update?.latest_version === "1.0.1", "notice update should survive normalization");

const failed = toolResult("edit", {
  error: {
    type: "scope",
    subtype: "scope_drift",
    code: "SCOPE_DRIFT",
    message: "scope drift detected",
    hint: "return to hy_edit",
    retryable: false,
    request_id: "req-2",
    trace_id: "trace-2",
  },
  allowedTools: ["hy_edit"],
});
assert(failed.ok === false, "error envelope should not be ok");
assert(failed.error?.type === "scope", "scope error should be classified");
assert(failed.error?.message.includes("scope drift"), "error message should survive normalization");
assert(failed.error?.code === "SCOPE_DRIFT", "error code should survive normalization");
assert(failed.error?.hint === "return to hy_edit", "error hint should survive normalization");
assert(failed.error?.request_id === "req-2", "error request_id should survive normalization");
assert(failed.allowedTools?.includes("hy_edit"), "allowedTools should survive normalization");
