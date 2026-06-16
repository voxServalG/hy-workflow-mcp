import { legacyRuntimeDiagnostics, readState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { initArtifactGuidance } from "./init.js";
import { checkSetupStamp } from "../bootstrap.js";

export async function handleStatus(): Promise<ToolResult> {
  const state = readState();
  const legacyDiagnostics = legacyRuntimeDiagnostics();
  const artifactGuidance = initArtifactGuidance();
  const setupUpdateCheck = checkSetupStamp();
  const allowedTools = state.pendingAmendment && state.phase === "verify"
    ? ["hy_amend_plan", "hy_verify", "hy_status"]
    : [state.phase === "done" ? "hy_status" : `hy_${state.phase}`, "hy_status"];

  const r: ToolResult & Record<string, any> = toolResult(state.phase, {
    phase: state.phase,
    branch: state.branch,
    prNumber: state.prNumber,
    plan: state.plan?.task ?? null,
    approved: state.approval !== null,
    verified: state.verifyHash !== null,
    hint: legacyDiagnostics.length
      ? `Use phase, next, allowedTools, and action to decide the next safe tool call. Legacy runtime cleanup needed: ${legacyDiagnostics.map(d => d.remediation ?? d.message).join(" ")}`
      : "Use phase, next, allowedTools, and action to decide the next safe tool call.",
    allowedTools,
    commitArtifacts: artifactGuidance.commitArtifacts,
    localArtifacts: artifactGuidance.localArtifacts,
    setupUpdateCheck,
    pendingAmendment: state.pendingAmendment ?? undefined,
    implementationManifest: state.implementationManifest ?? undefined,
    legacyDiagnostics: legacyDiagnostics.length ? legacyDiagnostics : undefined,
  });

  if (!state.plan) {
    r.action = {
      command: "hy_plan",
      when: "用户意图涉及开发任务时",
      triggerWords: ["计划一下", "plan it", "做个计划", "plan", "做计划", "plan this"],
    };
  }

  return r;
}
