import * as fs from "node:fs";
import * as path from "node:path";
import { projectRoot, statePath, type Phase } from "./state.js";
import { toolResult, type ToolResult } from "./tools/_base.js";
import { projectPaths } from "./runtime/user-paths.js";
import {
  MINIMAL_PROJECT_CONTRACT,
  readDeployment,
  type DeploymentManifest,
  type LegacyDeploymentManifest,
} from "./runtime/deployment.js";

export const SETUP_VERSION = "2026.07.16.1";
export const SETUP_STAMP = path.join(".git", "hy-workflow", "setup.json");
export const LEGACY_SETUP_STAMP = path.join(".hy", "hy-workflow-setup.json");
export const INSTALL_COMMAND = "npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest";
export const MIRROR_INSTALL_COMMAND = `${INSTALL_COMMAND} --registry=https://registry.npmmirror.com`;
export const SETUP_COMMAND = `${INSTALL_COMMAND}\nhy-workflow setup`;
export const WINDOWS_SETUP_COMMAND = SETUP_COMMAND;

export type SetupStamp = DeploymentManifest | LegacyDeploymentManifest;

/** Kept in the public type during the compatibility window; runtime never emits it. */
export type SetupArtifactDrift = {
  file: string;
  reason: "missing_record" | "missing_file" | "content_changed";
  expectedSha256: string | null;
  actualSha256: string | null;
  expectedSize: number | null;
  actualSize: number | null;
};

export type SetupCheck = {
  status: "current" | "missing_stamp" | "outdated" | "unreadable" | "tool_mismatch" | "artifact_drift";
  currentVersion: string | null;
  latestVersion: string;
  stampPath: string;
  issues?: string[];
  artifactDrift?: SetupArtifactDrift[];
  compatibility?: "minimal-v1" | "legacy-inert";
};

const BLOCKED_TOOLS = ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_merge"];

export function setupStampPath(root = projectRoot()): string {
  return projectPaths(root).deployment;
}

function validDeployment(root: string, deployment: SetupStamp): boolean {
  const expected = projectPaths(root).identity;
  const identity = deployment.identity;
  return (deployment.schemaVersion === "2" || deployment.schemaVersion === "3")
    && typeof deployment.setupVersion === "string"
    && typeof deployment.createdAt === "string"
    && typeof deployment.updatedAt === "string"
    && (deployment.mode === "shared" || deployment.mode === "local")
    && Array.isArray(deployment.clients)
    && deployment.clients.every(client => client === "codex" || client === "claude" || client === "opencode")
    && Boolean(identity)
    && identity.id === expected.id
    && identity.root === expected.root
    && identity.gitCommonDir === expected.gitCommonDir
    && identity.remote === expected.remote;
}

export function readSetupStamp(root = projectRoot()): SetupStamp | null {
  const deployment = readDeployment(root);
  return deployment && validDeployment(root, deployment) ? deployment : null;
}

/**
 * Runtime setup gating intentionally consults external deployment identity only.
 * Legacy repository injections, setup versions, tool snapshots, and artifact
 * hashes are not read or validated, so upgrading an installed project is silent.
 */
export function checkSetupStamp(root = projectRoot()): SetupCheck {
  const stampPath = setupStampPath(root);
  if (!fs.existsSync(stampPath)) {
    return { status: "missing_stamp", currentVersion: null, latestVersion: SETUP_VERSION, stampPath };
  }
  try {
    const deployment = readDeployment(root);
    if (!deployment?.setupVersion) {
      return { status: "unreadable", currentVersion: null, latestVersion: SETUP_VERSION, stampPath };
    }
    if (!validDeployment(root, deployment)) {
      return {
        status: "unreadable",
        currentVersion: deployment.setupVersion,
        latestVersion: SETUP_VERSION,
        stampPath,
        issues: ["Deployment identity does not match this project."],
      };
    }
    const compatibility = deployment.schemaVersion === "3" && deployment.projectContract === MINIMAL_PROJECT_CONTRACT
      ? "minimal-v1"
      : "legacy-inert";
    return {
      status: "current",
      currentVersion: deployment.setupVersion,
      latestVersion: SETUP_VERSION,
      stampPath,
      compatibility,
    };
  } catch (error: any) {
    return {
      status: "unreadable",
      currentVersion: null,
      latestVersion: SETUP_VERSION,
      stampPath,
      issues: [error?.message ?? String(error)],
    };
  }
}

export function setupUpdateRequiredResult(check: SetupCheck): ToolResult {
  const phase = readCurrentPhaseReadonly();
  const reason = check.status === "unreadable"
    ? `External deployment identity is unreadable or unsafe: ${check.stampPath}.`
    : `External deployment is missing: ${check.stampPath}.`;
  return toolResult(phase, {
    error: {
      type: "config",
      subtype: "setup_update_required",
      code: "SETUP_UPDATE_REQUIRED",
      message: `hy-workflow setup is required. ${reason}`,
      hint: "Run setup only to create or repair external deployment identity; existing repository injections are not migration inputs.",
      status: check.status,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      stampPath: check.stampPath,
      issues: check.issues,
      retryable: true,
    },
    display: {
      title: "hy-workflow setup required",
      body: [
        reason,
        "",
        "Install the tools and run setup in the project root:",
        SETUP_COMMAND,
        "",
        "Mainland China mirror alternative:",
        `${MIRROR_INSTALL_COMMAND}\nhy-workflow setup`,
      ].join("\n"),
    },
    hint: "Stop here only because external deployment identity is missing or unsafe.",
    requires_user: true,
    stop_here: true,
    allowedTools: ["hy_status"],
    blockedTools: BLOCKED_TOOLS,
    recovery: { tool: "terminal", instruction: SETUP_COMMAND },
    setupUpdateCheck: check,
  });
}

function readCurrentPhaseReadonly(): Phase {
  try {
    const filePath = statePath();
    if (!fs.existsSync(filePath)) return "init";
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed?.phase ?? "init";
  } catch {
    return "init";
  }
}

export function attachSetupCheck<T extends Record<string, any>>(result: T, check: SetupCheck): T {
  return { ...result, setupUpdateCheck: check };
}

export function createSetupGate(root = projectRoot()): () => ToolResult | null {
  return () => {
    const check = checkSetupStamp(root);
    return check.status === "current" ? null : setupUpdateRequiredResult(check);
  };
}
