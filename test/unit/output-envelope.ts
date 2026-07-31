import { toolResult, type ToolRecovery } from "../../src/output/envelope.js";
import { ERROR_ENVELOPE_FIELDS, OUTPUT_CONTROL_FIELDS, RECOVERY_FIELDS } from "../../src/output/contract.js";
import { TOOL_RECOVERY_STRATEGIES } from "../../src/output/control.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

for (const field of ["stage", "status", "nextAction", "control", "userAction", "data", "error", "summary", "checks", "findings", "pagination", "meta", "_notice"]) {
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
  recovery: { strategy: "repair_and_retry", tool: "hy_plan", arguments: { task: "repair contract", plan: {} }, command: "npm run lint:contract" },
  checks: [{ name: "contract", status: "passed" }],
  findings: [],
  pagination: { has_more: true, page_token: "p1", next_page_token: "p2" },
  meta: { command: "hy_plan", cwd: process.cwd(), identity: "agent", format: "json", version: "1", request_id: "req-1", trace_id: "trace-1", duration_ms: 12 },
  _notice: { update: { message: "current", command: "npm update", current_version: "1.0.0", latest_version: "1.0.1" } },
});
assert(ok.ok === true, "success envelope should be ok");
assert(ok.phase === "plan" && ok.next === "plan", "success envelope should include phase and next");
assert(ok.stage === "plan.compose", "success envelope should derive a stable intra-phase stage");
assert(ok.status === "ready", "status should survive normalization");
assert(ok.nextAction.tool === null, "normalization must not invent arguments for a parameterized tool");
assert(ok.control.stop && ok.userAction?.kind === "review_failure", "legacy requires_user should never be guessed as approval");
assert((ok.data as any).id === "plan-1", "data should survive normalization");
assert(ok.summary === "review this plan", "summary should survive normalization");
assert(ok.recovery?.strategy === "repair_and_retry", "recovery.strategy should survive normalization");
assert(ok.recovery?.command === "npm run lint:contract", "recovery.command should survive normalization");
assert((RECOVERY_FIELDS as readonly string[]).includes("arguments"), "recovery contract should expose executable arguments");
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
assert(failed.error?.message.includes("scope drift") === true, "error message should survive normalization");
assert(failed.error?.code === "SCOPE_DRIFT", "error code should survive normalization");
assert(failed.error?.hint === "return to hy_edit", "error hint should survive normalization");
assert(failed.error?.request_id === "req-2", "error request_id should survive normalization");
assert(failed.allowedTools?.includes("hy_edit") === true, "allowedTools should survive normalization");
assert(failed.stage === "edit.implementation" && failed.status === "blocked", "a failure without an explicit executable route should fail closed");
assert(failed.nextAction.tool === null && failed.control.stop && !failed.control.automatic, "an implicit failure route must never retry with missing arguments");
assert(failed.next === "edit", "legacy next must remain available");

const approval = toolResult("approve", {
  phase: "approve",
  stage: "approve.decision",
  status: "pending",
  requires_user: true,
  stop_here: true,
  allowedTools: ["hy_approve", "hy_status"],
  nextAction: { tool: null, phase: "approve", stage: "approve.decision", automatic: false },
  control: { automatic: false, stop: true, reason: "approval_required" },
  userAction: { kind: "approval", decisionId: "plan:abc123", options: ["approve", "reject", "revise"] },
});
assert(approval.userAction?.kind === "approval", "only an explicit typed decision gate should request approval");
assert(approval.userAction?.decisionId === "plan:abc123", "approval should bind one stable decision identity");
assert(approval.next === "approve" && approval.nextAction.automatic === false, "typed control must not remove legacy next");

const recoveryCases = [
  { strategy: "retry", tool: "hy_commit", arguments: { title: "fix: retry", body: "retry body" } },
  { strategy: "repair_and_retry", tool: "hy_edit" },
  { strategy: "wait_and_retry", tool: "hy_commit", arguments: { title: "fix: retry", body: "retry body" } },
  { strategy: "replan", tool: "hy_plan", arguments: { task: "revise", plan: {} } },
  { strategy: "reset", tool: "hy_reset" },
  { strategy: "external_action", tool: "terminal", command: "hy-workflow setup" },
] satisfies ToolRecovery[];

assert(
  recoveryCases.map(item => item.strategy).join(",") === TOOL_RECOVERY_STRATEGIES.join(","),
  "the discriminated recovery union should cover every canonical strategy",
);
for (const recovery of recoveryCases) {
  const result = toolResult("plan", { recovery });
  assert(result.recovery?.strategy === recovery.strategy, `recovery strategy ${recovery.strategy} should survive normalization`);
}

for (const invalid of [
  { tool: "hy_commit", instruction: "missing discriminator" },
  { strategy: "reset", tool: "hy_merge", instruction: "reset routed to the wrong tool" },
  { strategy: "retry", tool: "hy_commit" },
  { strategy: "retry", tool: "hy_commit", arguments: [] },
]) {
  let rejected = false;
  try {
    toolResult("plan", { recovery: invalid as ToolRecovery });
  } catch (error) {
    rejected = error instanceof TypeError;
  }
  assert(rejected, `invalid recovery should be rejected: ${JSON.stringify(invalid)}`);
}
