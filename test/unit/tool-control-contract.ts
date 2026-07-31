import { toolResult } from "../../src/output/envelope.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const automatic = toolResult("verify", {
  phase: "edit",
  allowedTools: ["hy_read_docs", "hy_status"],
});
assert(automatic.next === "verify", "legacy next should remain the requested next phase");
assert(automatic.phase === "edit", "phase should be the persisted workflow state");
assert(automatic.stage === "edit.implementation", "stage should describe progress inside phase");
assert(automatic.nextAction.tool === "hy_read_docs", "nextAction should name the concrete tool");
assert(automatic.control.automatic && !automatic.control.stop, "ordinary continuation should be automatic");
assert(automatic.userAction === null, "ordinary continuation should not invent human action");

const legacyStop = toolResult("commit", {
  error: "temporary failure",
  requires_user: true,
  stop_here: true,
  allowedTools: ["hy_commit", "hy_status"],
});
assert(legacyStop.userAction?.kind === "review_failure", "legacy stop fields must not be interpreted as approval");
assert(legacyStop.control.reason === "review_required", "legacy stop should have an explicit non-approval reason");

const complete = toolResult("done", { allowedTools: ["hy_reset", "hy_status"] });
assert(complete.status === "completed", "done should normalize to completed");
assert(complete.stage === "done.completed", "done should expose its terminal stage");
