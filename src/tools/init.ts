import * as fs from "node:fs";
import * as path from "node:path";
import { requireRuntimeConfig, resolveRuntimeConfig, type JsonObject } from "../config.js";
import { checkSetupStamp, setupStampPath, setupUpdateRequiredResult } from "../bootstrap.js";
import { isRuntimeIgnoredArtifact } from "../policy/artifacts.js";
import { projectPaths } from "../runtime/user-paths.js";
import { assertSafeRuntimeBoundary } from "../runtime/boundary.js";
import { assertPhase, projectRoot, readState, transition, writeState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { DEFAULT_STAGE_BY_PHASE } from "../runtime/state-machine.js";
import { validateBaseBranch } from "../project-profile.js";
import { isDocumentPath, resolveDocsDir } from "../docs_paths.js";
import { inspectDocumentation, shouldIgnoreDocumentPath } from "../policy/docs.js";
import { collectProjectCognition } from "../init-cognition.js";

export const INIT_COMMIT_ARTIFACTS: string[] = [];
export const INIT_LOCAL_ARTIFACTS: string[] = [];
export const REQUIRED_SETUP_ARTIFACTS = ["external deployment manifest"];

export function ensureLocalArtifactIgnores(_root: string): boolean {
  return false;
}

export type ProjectReadinessIssue = {
  code: string;
  message: string;
  recovery: string;
};

export type ProjectReadinessIssueFact = Omit<ProjectReadinessIssue, "recovery">;

export function projectReadinessFacts(issues: readonly ProjectReadinessIssue[]): ProjectReadinessIssueFact[] {
  return issues.map(({ recovery: _recovery, ...facts }) => facts);
}

function documentationFiles(root: string, docsDir: string): string[] {
  if (isRuntimeIgnoredArtifact(root, docsDir)) return [];
  const resolved = resolveDocsDir(root, docsDir);
  if (!resolved.ok || !fs.existsSync(resolved.docsRoot)) return [];
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (shouldIgnoreDocumentPath(relative)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isDocumentPath(entry.name)) files.push(relative);
    }
  };
  walk(resolved.docsRoot);
  return files;
}

export function projectReadinessIssues(root: string, candidate?: JsonObject, options: { forSetup?: boolean } = {}): ProjectReadinessIssue[] {
  const config = candidate ?? requireRuntimeConfig(root);
  const issues: ProjectReadinessIssue[] = [];
  const branch = validateBaseBranch(root, config.project.baseBranch as string);
  if (!branch.ok) issues.push({
    code: "BASE_BRANCH_NOT_FOUND",
    message: branch.issue!,
    recovery: "Choose a local or origin branch that resolves to a commit, then update project.baseBranch.",
  });
  const docs = documentationFiles(root, config.project.docsDir as string);
  for (const issue of inspectDocumentation(root, docs, { includeAgents: false }).issues) {
    issues.push({ code: issue.code, message: issue.message, recovery: issue.recovery });
  }
  return issues;
}

export function setupArtifactStatus(root: string): { requiredArtifacts: string[]; missingArtifacts: string[]; invalidArtifacts: string[]; ready: boolean } {
  const missingArtifacts: string[] = [];
  const invalidArtifacts: string[] = [];
  const stamp = checkSetupStamp(root);
  if (stamp.status !== "current") missingArtifacts.push(setupStampPath(root));
  try { invalidArtifacts.push(...projectReadinessIssues(root).map(issue => `${issue.code}: ${issue.message}`)); }
  catch (error: any) { invalidArtifacts.push(error?.message ?? String(error)); }
  return {
    requiredArtifacts: [setupStampPath(root)],
    missingArtifacts,
    invalidArtifacts,
    ready: missingArtifacts.length === 0 && invalidArtifacts.length === 0,
  };
}

export function harnessArtifactStatus(root: string): { requiredArtifacts: string[]; missingArtifacts: string[]; ready: boolean } {
  return setupArtifactStatus(root);
}

function setupMissingResult(missingArtifacts: string[]): ToolResult {
  return toolResult("init", {
    error: {
      type: "setup_artifacts_missing",
      legacyType: "harness_missing",
      message: "The external project deployment is missing or unsafe. hy_init never launches the interactive setup TUI.",
      missingArtifacts,
    },
    requires_user: true,
    stop_here: true,
    allowedTools: ["hy_init", "hy_status"],
    blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_amend_plan", "hy_commit", "hy_merge", "hy_reset"],
    recovery: { strategy: "external_action", tool: "terminal" },
    userAction: { kind: "external_action" },
    missingArtifacts,
  });
}

export async function handleInit(): Promise<ToolResult> {
  const root = projectRoot();
  assertSafeRuntimeBoundary(root);
  const state = readState();

  if (state.phase !== "init" && state.phase !== "plan") {
    const stage = state.stage ?? DEFAULT_STAGE_BY_PHASE[state.phase];
    return toolResult(state.phase, {
      stage,
      status: "ready",
      allowedTools: ["hy_status"],
      nextAction: { tool: "hy_status", phase: state.phase, stage, automatic: true },
      control: { automatic: true, stop: false, reason: "automatic" },
      userAction: null,
    });
  }

  assertPhase(state, "init", "plan");
  const setupCheck = checkSetupStamp(root);
  if (setupCheck.status !== "current") {
    if (setupCheck.status === "missing_stamp") return setupMissingResult([setupCheck.stampPath]);
    return setupUpdateRequiredResult(setupCheck);
  }

  let config: JsonObject;
  let configAuthority: ReturnType<typeof resolveRuntimeConfig>["authority"];
  try {
    config = requireRuntimeConfig(root);
    configAuthority = resolveRuntimeConfig(root).authority;
  } catch (error: any) {
    return toolResult(state.phase, {
      error: {
        type: "config",
        subtype: "config_invalid",
        code: error?.code ?? "ROOT_CONFIG_INVALID",
        message: error?.message ?? String(error),
        detail: error?.detail,
        retryable: false,
      },
      requires_user: true,
      stop_here: true,
      userAction: { kind: "fix_configuration" },
      allowedTools: ["hy_init", "hy_status"],
      blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_amend_plan", "hy_commit", "hy_merge", "hy_reset"],
    });
  }

  const readinessIssues = projectReadinessIssues(root, config);
  if (readinessIssues.length) {
    const first = readinessIssues[0];
    return toolResult(state.phase, {
      error: {
        type: "setup",
        subtype: "preflight",
        code: first.code,
        message: first.message,
        detail: { issues: projectReadinessFacts(readinessIssues) },
        retryable: false,
      },
      requires_user: true,
      stop_here: true,
      userAction: { kind: "fix_configuration" },
      allowedTools: ["hy_init", "hy_status"],
      blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_commit", "hy_merge", "hy_reset"],
    });
  }

  const next = state.phase === "init" ? transition(state, "plan") : state;
  next.stage = "plan.before_plan";
  writeState(next);
  const paths = projectPaths(root);
  const cognition = collectProjectCognition(root);
  return toolResult("plan", {
    stage: "plan.before_plan",
    status: "ready",
    allowedTools: ["hy_read_docs", "hy_status"],
    nextAction: {
      tool: null,
      phase: "plan",
      stage: "plan.before_plan",
      automatic: false,
    },
    control: { automatic: false, stop: true, reason: "information_required" },
    userAction: { kind: "provide_information" },
    commitArtifacts: [],
    localArtifacts: [paths.configDir, paths.stateDir, paths.cacheDir],
    projectFilesChanged: [],
    requiredSetupArtifacts: [paths.deployment],
    configAuthority,
    cognition,
    gitignoreChanged: false,
  });
}
