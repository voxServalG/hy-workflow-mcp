import { amendmentDecisionId, approvalMatchesPlan, documentReadHealth, pendingApprovalMatchesPlan, planDecisionId, projectRoot, readState } from "../state.js";
import { invalidWorkflowStateResult, toolResult, type ToolResult } from "./_base.js";
import { INIT_COMMIT_ARTIFACTS } from "./init.js";
import { checkSetupStamp, readSetupStamp } from "../bootstrap.js";
import { getStartupExecutorCapabilities } from "../executors.js";
import { projectPaths } from "../runtime/user-paths.js";
import { DEFAULT_STAGE_BY_PHASE, type Phase, type WorkflowStage } from "../runtime/state-machine.js";

export async function handleStatus(): Promise<ToolResult> {
  const state = readState();
  const persistedStage = state.stage ?? DEFAULT_STAGE_BY_PHASE[state.phase];
  const planRequired = ["approve", "branch", "edit", "verify", "commit", "merge"].includes(state.phase);
  if (planRequired && !state.plan) {
    return invalidWorkflowStateResult(
      state,
      "WORKFLOW_PLAN_MISSING",
      `Workflow phase ${state.phase} requires an active PlanDoc.`,
      "Reset the impossible workflow state before starting a new approved task.",
    );
  }
  const approved = approvalMatchesPlan(state.approval, state.plan);
  const approvalRequired = ["branch", "edit", "verify", "commit", "merge"].includes(state.phase);
  if (approvalRequired && !approved) {
    return invalidWorkflowStateResult(
      state,
      "WORKFLOW_APPROVAL_MISMATCH",
      `Workflow phase ${state.phase} requires an approval bound to the active PlanDoc.`,
      "Reset the invalid workflow state before creating a new approved PlanDoc.",
    );
  }
  if (state.phase === "commit" && !state.branch) {
    return invalidWorkflowStateResult(
      state,
      "WORKFLOW_BRANCH_MISSING",
      "Commit phase requires an active workflow branch.",
      "Reset the impossible workflow state before starting a new approved task.",
    );
  }
  const setupUpdateCheck = checkSetupStamp();
  let deployment: ReturnType<typeof readSetupStamp> = null;
  try { deployment = readSetupStamp(); } catch {}
  const paths = projectPaths(projectRoot());
  const health = documentReadHealth(state);
  const needsBeforePlan = state.phase === "plan" && !state.plan && health.gates.beforePlan.status !== "current";
  const readyToComposePlan = state.phase === "plan" && !state.plan && health.gates.beforePlan.status === "current";
  const approvalAuditInProgress = state.phase === "approve"
    && !approved
    && pendingApprovalMatchesPlan(state.pendingApproval, state.plan);
  const needsBeforeApprove = approvalAuditInProgress && !health.okForApprove;
  const readyToApplyApproval = approvalAuditInProgress && health.okForApprove;
  const approvalAuditNeedsReview = readyToApplyApproval
    && state.documentReads?.beforeApprove?.changedSinceBaseline === true;

  const decisionId = state.pendingAmendment
    ? amendmentDecisionId(state.plan, state.pendingAmendment)
    : planDecisionId(state.plan);
  const waitingForAmendmentApproval = state.phase === "verify" && Boolean(state.pendingAmendment);
  const waitingForPlanApproval = state.phase === "approve" && !approved && !approvalAuditInProgress;
  const activeExam = state.phase === "verify" ? state.activeExam ?? null : null;
  const activeExamExpired = Boolean(activeExam && Date.now() >= Date.parse(activeExam.expiresAt));
  const waitingForExamResults = Boolean(activeExam && !activeExamExpired);
  let allowedTools: string[];
  let nextTool: string | null;
  let nextPhase: Phase = state.phase;
  let nextStage: WorkflowStage = persistedStage;
  let nextArguments: Record<string, unknown> | undefined;

  if (waitingForAmendmentApproval) {
    allowedTools = ["hy_amend_plan", "hy_verify", "hy_status"];
    nextTool = null;
    nextStage = "verify.amendment";
  } else if (needsBeforePlan) {
    allowedTools = ["hy_read_docs", "hy_plan", "hy_status"];
    nextTool = null;
    nextStage = "plan.before_plan";
  } else if (readyToComposePlan) {
    allowedTools = ["hy_plan", "hy_status"];
    nextTool = null;
    nextStage = "plan.compose";
  } else if (waitingForPlanApproval) {
    allowedTools = ["hy_approve", "hy_status"];
    nextTool = null;
    nextStage = "approve.decision";
  } else if (needsBeforeApprove) {
    allowedTools = ["hy_read_docs", "hy_approve", "hy_status"];
    nextTool = "hy_read_docs";
    nextStage = "approve.before_approve";
    nextArguments = { stage: "before_approve" };
  } else if (approvalAuditNeedsReview) {
    allowedTools = ["hy_approve", "hy_status"];
    nextTool = null;
    nextStage = "approve.before_approve";
  } else if (readyToApplyApproval) {
    allowedTools = ["hy_approve", "hy_status"];
    nextTool = "hy_approve";
    nextStage = "approve.decision";
    nextArguments = {
      approved: "approve",
      decisionId,
      note: state.pendingApproval?.note ?? "",
      auditDecision: "continue",
    };
  } else if (state.phase === "approve" && approved) {
    allowedTools = ["hy_branch", "hy_status"];
    nextTool = null;
    nextPhase = "branch";
    nextStage = "branch.create";
  } else if (state.phase === "branch") {
    allowedTools = ["hy_branch", "hy_status"];
    nextTool = null;
    nextStage = "branch.create";
  } else if (state.phase === "edit") {
    if (persistedStage === "edit.after_edit") {
      allowedTools = ["hy_sync_docs", "hy_edit", "hy_status"];
      nextTool = null;
      nextStage = "edit.after_edit";
    } else if (persistedStage === "edit.sync_docs") {
      allowedTools = ["hy_verify", "hy_exam_plan", "hy_edit", "hy_status"];
      nextTool = "hy_verify";
      nextPhase = "verify";
      nextStage = "verify.run";
    } else if (persistedStage === "edit.scope") {
      allowedTools = ["hy_edit", "hy_status"];
      nextTool = "hy_edit";
    } else {
      allowedTools = ["hy_read_docs", "hy_edit", "hy_status"];
      nextTool = null;
      nextStage = "edit.implementation";
    }
  } else if (state.phase === "verify") {
    const blocked = health.blockedBy;
    if (blocked?.tool === "hy_read_docs" || blocked?.tool === "hy_sync_docs") {
      allowedTools = [blocked.tool, "hy_status"];
      nextTool = blocked.tool;
      nextPhase = "edit";
      nextStage = "edit.after_edit";
      nextArguments = blocked.tool === "hy_read_docs" ? { stage: "after_edit" } : undefined;
    } else if (activeExam && !activeExamExpired) {
      allowedTools = ["hy_exam_submit", "hy_status"];
      nextTool = null;
      nextStage = "verify.run";
    } else if (activeExamExpired) {
      allowedTools = ["hy_exam_plan", "hy_status"];
      nextTool = "hy_exam_plan";
      nextStage = "verify.run";
    } else {
      allowedTools = ["hy_verify", "hy_exam_plan", "hy_status"];
      nextTool = "hy_verify";
      nextStage = "verify.run";
    }
  } else if (state.phase === "commit") {
    allowedTools = ["hy_commit", "hy_status"];
    nextStage = state.stage ?? "commit.prepare";
    if (state.commitIntent) {
      nextTool = "hy_commit";
      nextArguments = { title: state.commitIntent.title, body: state.commitIntent.body };
    } else {
      nextTool = null;
    }
  } else if (state.phase === "merge") {
    allowedTools = ["hy_merge", "hy_status"];
    nextTool = "hy_merge";
  } else if (state.phase === "done") {
    allowedTools = ["hy_reset", "hy_status"];
    nextTool = "hy_reset";
  } else if (state.phase === "init") {
    allowedTools = ["hy_init", "hy_status"];
    nextTool = "hy_init";
  } else {
    allowedTools = ["hy_plan", "hy_status"];
    nextTool = null;
    nextStage = "plan.compose";
  }
  const needsTaskInformation = needsBeforePlan;
  const needsAgentInput = readyToComposePlan
    || state.phase === "plan" && !needsBeforePlan
    || state.phase === "branch"
    || state.phase === "commit" && !state.commitIntent
    || state.phase === "approve" && approved;
  const needsExternalWork = waitingForExamResults
    || (state.phase === "edit"
      && (persistedStage === "edit.implementation" || persistedStage === "edit.after_edit"));
  const continueAutomatically = !waitingForPlanApproval
    && !waitingForAmendmentApproval
    && !needsTaskInformation
    && !needsAgentInput
    && !needsExternalWork
    && !approvalAuditNeedsReview
    && nextTool !== null;

  const r: ToolResult & Record<string, any> = toolResult(state.phase, {
    phase: state.phase,
    stage: persistedStage,
    branch: state.branch,
    prNumber: state.prNumber,
    plan: state.plan?.task ?? null,
    approved,
    verified: Boolean(
      state.plan
      && state.branch
      && approvalMatchesPlan(state.approval, state.plan)
      && state.implementationManifest
      && state.verifiedImplementationDigest
    ),
    allowedTools,
    commitArtifacts: [...INIT_COMMIT_ARTIFACTS],
    localArtifacts: [paths.configDir, paths.stateDir, paths.cacheDir],
    projectIdentity: paths.identity,
    runtimePaths: {
      config: paths.config,
      deployment: paths.deployment,
      workflowState: paths.workflowState,
      scope: paths.scope,
      docsGraph: paths.docsGraph,
    },
    setupUpdateCheck,
    deploymentHealth: deployment ? {
      schemaVersion: deployment.schemaVersion,
      setupVersion: deployment.setupVersion,
    } : null,
    capabilities: getStartupExecutorCapabilities(),
    pendingAmendment: state.pendingAmendment ?? undefined,
    decisionId: decisionId ?? undefined,
    implementationManifest: state.implementationManifest ?? undefined,
    documentReads: state.documentReads ?? undefined,
    documentReadHealth: health,
    blockedBy: health.blockedBy ?? undefined,
    staleDocumentReads: health.staleDocumentReads.length ? health.staleDocumentReads : undefined,
    ...(state.commitIntent ? {
      commitArguments: {
        title: state.commitIntent.title,
        body: state.commitIntent.body,
      },
    } : {}),
    ...(activeExam ? {
      examId: activeExam.examId,
      issuedAt: activeExam.issuedAt,
      expiresAt: activeExam.expiresAt,
      scopeFingerprint: activeExam.scopeFingerprint,
      nonce: activeExam.nonce,
      checks: activeExam.checks,
      examExpired: activeExamExpired,
    } : {}),
    nextAction: {
      tool: nextTool,
      arguments: nextArguments,
      phase: nextPhase,
      stage: nextStage,
      automatic: continueAutomatically,
    },
    control: waitingForPlanApproval || waitingForAmendmentApproval
      ? { automatic: false, stop: true, reason: "approval_required" }
      : needsTaskInformation
        ? { automatic: false, stop: true, reason: "information_required" }
      : needsAgentInput
        ? { automatic: false, stop: true, reason: "information_required" }
      : approvalAuditNeedsReview
        ? { automatic: false, stop: true, reason: "review_required" }
      : needsExternalWork
        ? { automatic: false, stop: true, reason: "external_action_required" }
      : state.phase === "done"
        ? { automatic: continueAutomatically, stop: !continueAutomatically, reason: "completed" }
        : { automatic: true, stop: false, reason: "automatic" },
    userAction: waitingForPlanApproval || waitingForAmendmentApproval
      ? { kind: "approval", decisionId: decisionId ?? undefined, options: ["approve", "reject", "revise"] }
      : needsTaskInformation
        ? { kind: "provide_information" }
        : null,
  });

  return r;
}
