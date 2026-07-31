import { amendmentDecisionId, approvalMatchesPlan, documentReadHealth, planDecisionId, projectRoot, readState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { initArtifactGuidance } from "./init.js";
import { checkSetupStamp, readSetupStamp } from "../bootstrap.js";
import { getStartupExecutorCapabilities } from "../executors.js";
import { projectPaths } from "../runtime/user-paths.js";
import { DEFAULT_STAGE_BY_PHASE } from "../runtime/state-machine.js";

export async function handleStatus(): Promise<ToolResult> {
  const state = readState();
  const artifactGuidance = initArtifactGuidance();
  const setupUpdateCheck = checkSetupStamp();
  let deployment: ReturnType<typeof readSetupStamp> = null;
  try { deployment = readSetupStamp(); } catch {}
  const paths = projectPaths(projectRoot());
  const health = documentReadHealth(state);
  const needsBeforePlan = state.phase === "plan" && !state.plan;
  const needsBeforeApprove = state.phase === "approve" && !health.okForApprove;
  const allowedTools = state.pendingAmendment && state.phase === "verify"
    ? ["hy_amend_plan", "hy_verify", "hy_status"]
    : needsBeforePlan
      ? ["hy_read_docs", "hy_plan", "hy_status"]
      : needsBeforeApprove
        ? ["hy_read_docs", "hy_approve", "hy_status"]
        : [state.phase === "done" ? "hy_reset" : `hy_${state.phase}`, "hy_status"];

  const decisionId = state.pendingAmendment
    ? amendmentDecisionId(state.plan, state.pendingAmendment)
    : planDecisionId(state.plan);
  const waitingForAmendmentApproval = state.phase === "verify" && Boolean(state.pendingAmendment);
  const waitingForPlanApproval = state.phase === "approve" && !needsBeforeApprove;
  const currentStage = waitingForAmendmentApproval
    ? "verify.amendment" as const
    : needsBeforePlan
      ? "plan.before_plan" as const
      : needsBeforeApprove
        ? "approve.before_approve" as const
        : waitingForPlanApproval
          ? "approve.decision" as const
          : state.stage ?? DEFAULT_STAGE_BY_PHASE[state.phase];
  const nextTool = state.pendingAmendment && state.phase === "verify"
    ? "hy_amend_plan"
    : needsBeforePlan
      ? "hy_read_docs"
      : needsBeforeApprove
        ? "hy_read_docs"
        : waitingForPlanApproval
        ? "hy_approve"
        : state.phase === "done"
          ? "hy_reset"
          : allowedTools.find(tool => tool !== "hy_status") ?? null;

  const r: ToolResult & Record<string, any> = toolResult(state.phase, {
    phase: state.phase,
    stage: currentStage,
    branch: state.branch,
    prNumber: state.prNumber,
    plan: state.plan?.task ?? null,
    approved: approvalMatchesPlan(state.approval, state.plan),
    verified: Boolean(
      state.plan
      && state.branch
      && approvalMatchesPlan(state.approval, state.plan)
      && state.implementationManifest
      && state.verifiedImplementationDigest
    ),
    hint: "Use phase for persisted state, stage for intra-phase progress, and nextAction/control/userAction for continuation. The legacy next field remains for compatibility.",
    allowedTools,
    commitArtifacts: artifactGuidance.commitArtifacts,
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
    implementationManifest: state.implementationManifest ?? undefined,
    documentReads: state.documentReads ?? undefined,
    documentReadHealth: health,
    blockedBy: health.blockedBy ?? undefined,
    staleDocumentReads: health.staleDocumentReads.length ? health.staleDocumentReads : undefined,
    nextAction: {
      tool: nextTool,
      arguments: needsBeforePlan
        ? { stage: "before_plan", task: "<user task>" }
        : needsBeforeApprove
          ? { stage: "before_approve" }
          : undefined,
      phase: state.phase,
      stage: currentStage,
      automatic: !waitingForPlanApproval && !waitingForAmendmentApproval && state.phase !== "done",
    },
    control: waitingForPlanApproval || waitingForAmendmentApproval
      ? { automatic: false, stop: true, reason: "approval_required" }
      : state.phase === "done"
        ? { automatic: true, stop: false, reason: "completed" }
        : { automatic: true, stop: false, reason: "automatic" },
    userAction: waitingForPlanApproval || waitingForAmendmentApproval
      ? { kind: "approval", decisionId: decisionId ?? undefined, options: ["approve", "reject", "revise"] }
      : null,
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
