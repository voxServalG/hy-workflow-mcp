import { documentReadHealth, legacyRuntimeDiagnostics, readState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { initArtifactGuidance } from "./init.js";
import { checkSetupStamp } from "../bootstrap.js";
import { getStartupExecutorCapabilities } from "../executors.js";

export async function handleStatus(): Promise<ToolResult> {
  const state = readState();
  const legacyDiagnostics = legacyRuntimeDiagnostics();
  const artifactGuidance = initArtifactGuidance();
  const setupUpdateCheck = checkSetupStamp();
  const health = documentReadHealth(state);
  const needsBeforePlan = state.phase === "plan" && !state.plan;
  const needsBeforeApprove = state.phase === "approve" && !health.okForApprove;
  const allowedTools = state.pendingAmendment && state.phase === "verify"
    ? ["hy_amend_plan", "hy_verify", "hy_status"]
    : needsBeforePlan
      ? ["hy_read_docs", "hy_plan", "hy_status"]
      : needsBeforeApprove
        ? ["hy_read_docs", "hy_approve", "hy_status"]
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
    capabilities: getStartupExecutorCapabilities(),
    pendingAmendment: state.pendingAmendment ?? undefined,
    implementationManifest: state.implementationManifest ?? undefined,
    documentReads: state.documentReads ?? undefined,
    documentReadHealth: health,
    blockedBy: health.blockedBy ?? undefined,
    staleDocumentReads: health.staleDocumentReads.length ? health.staleDocumentReads : undefined,
    legacyDiagnostics: legacyDiagnostics.length ? legacyDiagnostics : undefined,
  });

  if (needsBeforePlan) {
    r.action = {
      command: "hy_read_docs",
      when: "用户意图涉及开发任务时，在 hy_plan 前自动建立文档事实基线",
      arguments: { stage: "before_plan", task: "<user task>" },
      triggerWords: ["计划一下", "plan it", "做个计划", "plan", "做计划", "plan this"],
    };
  } else if (needsBeforeApprove) {
    r.action = {
      command: "hy_read_docs",
      when: "用户已经批准 PlanDoc 时，在 hy_approve 前自动做文档审计",
      arguments: { stage: "before_approve" },
    };
  }

  return r;
}
