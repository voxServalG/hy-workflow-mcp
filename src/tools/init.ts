import * as fs from "node:fs";
import * as path from "node:path";
import { requireRuntimeConfig, resolveRuntimeConfig, type JsonObject } from "../config.js";
import { checkSetupStamp, SETUP_COMMAND, setupStampPath, setupUpdateRequiredResult } from "../bootstrap.js";
import { isRuntimeIgnoredArtifact } from "../policy/artifacts.js";
import { projectPaths } from "../runtime/user-paths.js";
import { assertSafeRuntimeBoundary } from "../runtime/boundary.js";
import { assertPhase, projectRoot, readState, transition, writeState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";
import { validateBaseBranch } from "../project-profile.js";
import { isDocumentPath, resolveDocsDir } from "../docs_paths.js";
import { inspectDocumentation, shouldIgnoreDocumentPath } from "../policy/docs.js";

export const INIT_COMMIT_ARTIFACTS: string[] = [];
export const INIT_LOCAL_ARTIFACTS: string[] = [];
export const REQUIRED_SETUP_ARTIFACTS = ["external deployment manifest"];

export function ensureLocalArtifactIgnores(_root: string): boolean {
  return false;
}

export function initArtifactGuidance(): { commitArtifacts: string[]; localArtifacts: string[]; trackedLocalArtifacts: string[]; body: string } {
  const body = [
    "hy_init changes no project files. Runtime authority, workflow state, scope locks, and DocsGraph cache live in OS user directories.",
    "Historical repository injections are inert: runtime does not read, hash, migrate, delete, or validate them.",
    "",
    "hy-workflow unset removes only external state and owned user-scope client configuration; it never deletes project files.",
  ].join("\n");
  return {
    commitArtifacts: [],
    localArtifacts: [...INIT_LOCAL_ARTIFACTS],
    trackedLocalArtifacts: [],
    body,
  };
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

export function projectReadinessIssues(root: string, candidate?: JsonObject, options: { forSetup?: boolean } = {}): Array<{ code: string; message: string; recovery: string }> {
  const config = candidate ?? requireRuntimeConfig(root);
  const issues: Array<{ code: string; message: string; recovery: string }> = [];
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
    display: {
      title: "Setup required",
      body: ["Run setup in the project root, then restart the MCP session:", SETUP_COMMAND].join("\n"),
    },
    hint: "Stop here and ask the user to run hy-workflow setup. Do not call hy_plan until hy_init succeeds.",
    requires_user: true,
    stop_here: true,
    allowedTools: ["hy_init", "hy_status"],
    blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_amend_plan", "hy_commit", "hy_merge", "hy_reset"],
    recovery: { tool: "terminal", instruction: SETUP_COMMAND },
    missingArtifacts,
  });
}

export async function handleInit(): Promise<ToolResult> {
  const root = projectRoot();
  assertSafeRuntimeBoundary(root);
  const state = readState();

  if (state.phase !== "init" && state.phase !== "plan") {
    return toolResult(state.phase, {
      stage: "init.ready",
      status: "ready",
      message: `Workflow is already active in ${state.phase}; hy_init left it unchanged.`,
      hint: "Call hy_status and resume the persisted pipeline. Do not initialize or approve again.",
      allowedTools: ["hy_status"],
      nextAction: { tool: "hy_status", phase: state.phase, stage: "init.ready", automatic: true },
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
        hint: error?.hint,
        issues: error?.detail?.issues,
        retryable: false,
      },
      display: { title: "Project configuration needs attention", body: error?.message ?? String(error) },
      hint: error?.hint ?? "Repair the authoritative configuration, then rerun hy_init.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_init", "hy_status"],
      blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_amend_plan", "hy_commit", "hy_merge", "hy_reset"],
    });
  }

  const readinessIssues = projectReadinessIssues(root, config);
  if (readinessIssues.length) {
    const first = readinessIssues[0];
    return toolResult(state.phase, {
      error: { type: "setup", subtype: "preflight", code: first.code, message: first.message, issues: readinessIssues, retryable: false },
      display: { title: "Project setup needs attention", body: readinessIssues.map(issue => `- ${issue.message}\n  ${issue.recovery}`).join("\n") },
      hint: first.recovery,
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_init", "hy_status"],
      blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_commit", "hy_merge", "hy_reset"],
    });
  }

  const next = state.phase === "init" ? transition(state, "plan") : state;
  next.stage = "plan.before_plan";
  writeState(next);
  const paths = projectPaths(root);
  const artifactGuidance = initArtifactGuidance();
  return toolResult("plan", {
    display: {
      title: "Setup ready",
      body: `External deployment and authoritative runtime configuration verified. hy_init changed no project files.\n\n${artifactGuidance.body}`,
    },
    hint: "For a concrete repository change task, call hy_read_docs({ stage: 'before_plan', task }) before hy_plan.",
    allowedTools: ["hy_read_docs", "hy_status"],
    commitArtifacts: [],
    localArtifacts: [paths.configDir, paths.stateDir, paths.cacheDir],
    projectFilesChanged: [],
    requiredSetupArtifacts: [paths.deployment],
    configAuthority,
    gitignoreChanged: false,
    message: "External deployment and runtime config authority verified. hy_init changed no project files.",
  });
}
