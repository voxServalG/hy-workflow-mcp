import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { checkConfig, UNIFIED_CONFIG_FILE } from "../config.js";
import { checkSetupStamp, SETUP_COMMAND, setupStampPath, setupUpdateRequiredResult } from "../bootstrap.js";
import { isLocalArtifact, LOCAL_RUNTIME_ARTIFACTS } from "../policy/artifacts.js";
import { projectPaths } from "../runtime/user-paths.js";
import { assertPhase, legacyRuntimeDiagnostics, projectRoot, readState, transition, writeState } from "../state.js";
import { toolResult, type ToolResult } from "./_base.js";

export const INIT_COMMIT_ARTIFACTS: string[] = [];
export const INIT_LOCAL_ARTIFACTS = [...LOCAL_RUNTIME_ARTIFACTS];
export const REQUIRED_SETUP_ARTIFACTS = ["external deployment manifest", "root hy-workflow.json"];

export function ensureLocalArtifactIgnores(_root: string): boolean {
  return false;
}

export function trackedLocalArtifactDiagnostics(root: string): string[] {
  try {
    const tracked = execFileSync("git", ["ls-files"], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split(/\r?\n/).filter(Boolean);
    return tracked.filter(isLocalArtifact).sort();
  } catch {
    return [];
  }
}

export function initArtifactGuidance(
  trackedLocalArtifacts: string[] = [],
): { commitArtifacts: string[]; localArtifacts: string[]; trackedLocalArtifacts: string[]; body: string } {
  const body = [
    "Setup intentionally maintains only hy-workflow.json and .github/workflows/hy-workflow.yml in the repository; hy_init itself changes no project files.",
    "Deployment metadata, registry, workflow state, scope locks, DocsGraph cache, and client configuration live in OS user directories.",
    ...(trackedLocalArtifacts.length
      ? ["", "Legacy local/runtime files are tracked and should be removed in a separate cleanup change:", ...trackedLocalArtifacts.map(file => `- ${file}`)]
      : []),
    "",
    "hy-workflow unset removes the external project deployment but never deletes the two team-owned repository files.",
  ].join("\n");
  return {
    commitArtifacts: [],
    localArtifacts: [...INIT_LOCAL_ARTIFACTS],
    trackedLocalArtifacts: [...trackedLocalArtifacts],
    body,
  };
}

export function setupArtifactStatus(root: string): { requiredArtifacts: string[]; missingArtifacts: string[]; ready: boolean } {
  const missingArtifacts: string[] = [];
  const stamp = checkSetupStamp(root);
  if (stamp.status !== "current") missingArtifacts.push(setupStampPath(root));
  const configPath = path.join(root, UNIFIED_CONFIG_FILE);
  if (!fs.existsSync(configPath) || !checkConfig(root).ok) missingArtifacts.push(configPath);
  return {
    requiredArtifacts: [setupStampPath(root), configPath],
    missingArtifacts,
    ready: missingArtifacts.length === 0,
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
      message: "The external project deployment or root hy-workflow.json is missing. hy_init never launches the interactive setup TUI.",
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
    blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_amend_plan", "hy_commit", "hy_ci", "hy_merge", "hy_chain", "hy_reset"],
    recovery: { tool: "terminal", instruction: SETUP_COMMAND },
    missingArtifacts,
  });
}

export async function handleInit(): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "init", "plan");
  const root = projectRoot();
  const setupCheck = checkSetupStamp(root);
  if (setupCheck.status !== "current") {
    if (setupCheck.status === "missing_stamp") return setupMissingResult([setupCheck.stampPath]);
    return setupUpdateRequiredResult(setupCheck);
  }

  const configPath = path.join(root, UNIFIED_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return setupMissingResult([configPath]);
  const configStatus = checkConfig(root);
  if (!configStatus.ok) {
    return toolResult(state.phase, {
      error: { type: "config_confirmation_required", issues: configStatus.issues, project: configStatus.project },
      display: configStatus.display,
      hint: "Stop and show the suggested config command. Run it only after user approval, then rerun hy_init.",
      requires_user: true,
      stop_here: true,
      allowedTools: ["hy_init", "hy_status"],
      blockedTools: ["hy_read_docs", "hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_sync_docs", "hy_verify", "hy_amend_plan", "hy_commit", "hy_ci", "hy_merge", "hy_chain", "hy_reset"],
      recovery: configStatus.recovery,
      suggestedCommand: configStatus.suggestedCommand,
      configCheck: configStatus,
    });
  }

  const next = state.phase === "init" ? transition(state, "plan") : state;
  writeState(next);
  const paths = projectPaths(root);
  const trackedLocalArtifacts = trackedLocalArtifactDiagnostics(root);
  const artifactGuidance = initArtifactGuidance(trackedLocalArtifacts);
  const legacyDiagnostics = legacyRuntimeDiagnostics(root);
  return toolResult("plan", {
    display: {
      title: "Setup ready",
      body: `External deployment and root hy-workflow.json verified. hy_init changed no project files.\n\n${artifactGuidance.body}`,
    },
    hint: "For a concrete repository change task, call hy_read_docs({ stage: 'before_plan', task }) before hy_plan.",
    allowedTools: ["hy_read_docs", "hy_status"],
    commitArtifacts: [],
    localArtifacts: [paths.configDir, paths.stateDir, paths.cacheDir],
    projectFilesChanged: [],
    trackedLocalArtifacts: trackedLocalArtifacts.length ? trackedLocalArtifacts : undefined,
    requiredSetupArtifacts: [paths.deployment, configPath],
    gitignoreChanged: false,
    legacyDiagnostics: legacyDiagnostics.length ? legacyDiagnostics : undefined,
    message: "External deployment and shared project config verified. hy_init changed no project files.",
  });
}
