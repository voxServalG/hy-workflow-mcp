import * as fs from "node:fs";
import * as path from "node:path";
import { projectRoot, statePath, type Phase } from "./state.js";
import { toolResult, type ToolResult } from "./tools/_base.js";
import { projectPaths } from "./runtime/user-paths.js";
import { readDeployment, type DeploymentManifest } from "./runtime/deployment.js";
import { sharedArtifactEvidence, SHARED_PROJECT_FILES } from "./setup/shared.js";
import { MCP_DEFINITIONS, type ServerName } from "./setup/types.js";
import { resolveExecutable, versionOf } from "./setup/clients/index.js";

export const SETUP_VERSION = "2026.07.16.1";
export const SETUP_STAMP = path.join(".git", "hy-workflow", "setup.json");
export const LEGACY_SETUP_STAMP = path.join(".hy", "hy-workflow-setup.json");
export const INSTALL_COMMAND = "npm install -g @voxstudio/hy-workflow@latest @voxstudio/docs-gardener@latest";
export const MIRROR_INSTALL_COMMAND = `${INSTALL_COMMAND} --registry=https://registry.npmmirror.com`;
export const SETUP_COMMAND = `${INSTALL_COMMAND}\nhy-workflow setup`;
export const WINDOWS_SETUP_COMMAND = SETUP_COMMAND;

export type SetupStamp = DeploymentManifest;

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
};

const BLOCKED_TOOLS = ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"];

export function setupStampPath(root = projectRoot()): string {
  return projectPaths(root).deployment;
}

export function readSetupStamp(root = projectRoot()): SetupStamp | null {
  const deployment = readDeployment(root);
  if (!deployment || deployment.schemaVersion !== "3" || !validDeployment(root, deployment)) return null;
  return deployment;
}

function validDeployment(root: string, deployment: DeploymentManifest): boolean {
  const expected = projectPaths(root).identity;
  const identity = deployment.identity;
  return deployment.schemaVersion === "3"
    && typeof deployment.setupVersion === "string"
    && typeof deployment.createdAt === "string"
    && typeof deployment.updatedAt === "string"
    && deployment.mode === "shared"
    && Array.isArray(deployment.clients)
    && deployment.clients.every(client => client === "codex" || client === "claude" || client === "opencode")
    && Array.isArray(deployment.projectFiles)
    && deployment.projectFiles.every(file => typeof file === "string")
    && SHARED_PROJECT_FILES.every(file => deployment.projectFiles.includes(file))
    && Boolean(deployment.tools) && typeof deployment.tools === "object"
    && Boolean(deployment.artifacts) && typeof deployment.artifacts === "object"
    && Boolean(identity)
    && identity.id === expected.id
    && identity.root === expected.root
    && identity.gitCommonDir === expected.gitCommonDir
    && identity.remote === expected.remote;
}

function toolEvidenceIssues(deployment: DeploymentManifest): string[] {
  const issues: string[] = [];
  for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
    const evidence = deployment.tools[server];
    if (!evidence) {
      issues.push(`Missing tool evidence for ${server}`);
      continue;
    }
    if (evidence.command !== MCP_DEFINITIONS[server].command) {
      issues.push(`${server} command is ${JSON.stringify(evidence.command)}; expected ${JSON.stringify(MCP_DEFINITIONS[server].command)}`);
    }
    if (typeof evidence.executable !== "string" || !evidence.executable.trim()) issues.push(`${server} executable evidence is missing`);
    if (typeof evidence.version !== "string" || !evidence.version.trim()) issues.push(`${server} version evidence is missing`);
    if (typeof evidence.catalogHash !== "string" || !evidence.catalogHash.trim()) issues.push(`${server} MCP catalog evidence is missing`);
  }
  return issues;
}

function canonicalExecutable(file: string): string {
  let resolved = path.resolve(file);
  try { resolved = fs.realpathSync.native(resolved); } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function liveToolEvidenceIssues(deployment: DeploymentManifest): string[] {
  const issues: string[] = [];
  for (const server of Object.keys(MCP_DEFINITIONS) as ServerName[]) {
    const evidence = deployment.tools[server];
    if (!evidence || typeof evidence.executable !== "string" || !evidence.executable.trim()) continue;
    const recorded = path.resolve(evidence.executable);
    if (!fs.existsSync(recorded)) {
      issues.push(`${server} recorded executable is missing: ${recorded}`);
      continue;
    }
    const command = MCP_DEFINITIONS[server].command;
    const live = resolveExecutable(command);
    if (!live) {
      issues.push(`${server} command is no longer available on PATH: ${command}`);
      continue;
    }
    if (canonicalExecutable(live) !== canonicalExecutable(recorded)) {
      issues.push(`${server} executable path changed: current ${live}; recorded ${recorded}`);
      continue;
    }
    const liveVersion = versionOf(recorded);
    if (!liveVersion) {
      issues.push(`${server} recorded executable no longer returns --version: ${recorded}`);
    } else if (liveVersion !== evidence.version) {
      issues.push(`${server} version changed: current ${JSON.stringify(liveVersion)}; recorded ${JSON.stringify(evidence.version)}`);
    }
  }
  return issues;
}

function artifactDrift(root: string, deployment: DeploymentManifest): SetupArtifactDrift[] {
  const actual = sharedArtifactEvidence(root);
  const drift: SetupArtifactDrift[] = [];
  for (const file of SHARED_PROJECT_FILES) {
    const expected = deployment.artifacts[file];
    const current = actual[file];
    if (!expected) {
      drift.push({
        file,
        reason: "missing_record",
        expectedSha256: null,
        actualSha256: current?.sha256 ?? null,
        expectedSize: null,
        actualSize: current?.size ?? null,
      });
      continue;
    }
    if (!current) {
      drift.push({
        file,
        reason: "missing_file",
        expectedSha256: expected.sha256,
        actualSha256: null,
        expectedSize: expected.size,
        actualSize: null,
      });
      continue;
    }
    if (current.sha256 !== expected.sha256 || current.size !== expected.size) {
      drift.push({
        file,
        reason: "content_changed",
        expectedSha256: expected.sha256,
        actualSha256: current.sha256,
        expectedSize: expected.size,
        actualSize: current.size,
      });
    }
  }
  return drift;
}

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
    if (deployment.schemaVersion === "2") {
      return {
        status: "outdated",
        currentVersion: deployment.setupVersion,
        latestVersion: SETUP_VERSION,
        stampPath,
        issues: ["Deployment schema 2 is a read-only migration input; rerun setup to create schema 3 evidence."],
      };
    }
    if (!validDeployment(root, deployment)) {
      return { status: "unreadable", currentVersion: deployment.setupVersion, latestVersion: SETUP_VERSION, stampPath, issues: ["Deployment identity or schema fields do not match this project."] };
    }
    if (deployment.setupVersion !== SETUP_VERSION) {
      return { status: "outdated", currentVersion: deployment.setupVersion, latestVersion: SETUP_VERSION, stampPath };
    }
    const toolIssues = [...toolEvidenceIssues(deployment), ...liveToolEvidenceIssues(deployment)];
    if (toolIssues.length) {
      return { status: "tool_mismatch", currentVersion: deployment.setupVersion, latestVersion: SETUP_VERSION, stampPath, issues: toolIssues };
    }
    const drift = artifactDrift(root, deployment);
    if (drift.length) {
      return { status: "artifact_drift", currentVersion: deployment.setupVersion, latestVersion: SETUP_VERSION, stampPath, artifactDrift: drift };
    }
    return { status: "current", currentVersion: deployment.setupVersion, latestVersion: SETUP_VERSION, stampPath };
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
  const reason = check.status === "artifact_drift"
    ? `The three team artifacts no longer match the deployment evidence: ${check.artifactDrift?.map(item => `${item.file} (${item.reason})`).join(", ") ?? "unknown drift"}.`
    : check.status === "tool_mismatch"
      ? `Installed tool evidence is incomplete or stale: ${check.issues?.join("; ") ?? "unknown tool mismatch"}.`
      : check.status === "outdated"
    ? `Current setup version is ${check.currentVersion}; latest is ${check.latestVersion}.`
    : check.status === "unreadable"
      ? `Setup stamp exists but could not be read: ${check.stampPath}.`
      : `Setup stamp is missing: ${check.stampPath}.`;
  const artifactSync = check.status === "artifact_drift";
  const recoveryCommand = artifactSync
    ? "hy-workflow setup --dry-run --json"
    : SETUP_COMMAND;

  return toolResult(phase, {
    error: {
      type: artifactSync ? "setup" : "config",
      subtype: artifactSync ? "artifact_drift" : "setup_update_required",
      code: artifactSync ? "SETUP_ARTIFACT_DRIFT" : "SETUP_UPDATE_REQUIRED",
      message: artifactSync ? `hy-workflow setup artifact sync required. ${reason}` : `hy-workflow setup update required. ${reason}`,
      hint: artifactSync
        ? "Review the dry-run hashes and diff, then use the interactive setup TUI or pass --accept-artifact-changes with every exact --review-artifact file:before:after tuple (and exact --ci-command values when requested)."
        : "Run hy-workflow setup in the project root, then restart the agent/MCP session before calling hy_* tools again.",
      status: check.status,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      stampPath: check.stampPath,
      issues: check.issues,
      artifactDrift: check.artifactDrift,
      retryable: true,
    },
    display: {
      title: artifactSync ? "hy-workflow setup artifact sync required" : "hy-workflow setup update required",
      body: artifactSync ? [
        "The team-owned setup artifacts changed after the last accepted setup transaction.",
        reason,
        "",
        "Review without writing:",
        "hy-workflow setup --dry-run --json",
        "",
        "After reviewing the full diff, explicitly accept the intended artifact update:",
        "hy-workflow setup",
        "or: hy-workflow setup --yes --clients <list> --accept-artifact-changes --review-artifact '<file>:<before-sha256|absent>:<after-sha256>' [--review-artifact ...] [--ci-command '<exact command>'] --json",
      ].join("\n") : [
        "The user-local hy-workflow deployment needs to be installed or refreshed.",
        reason,
        "",
        "Install or update both npm packages, rerun setup in the project root, then restart the agent/MCP session:",
        SETUP_COMMAND,
        "",
        "Mainland China mirror alternative:",
        `${MIRROR_INSTALL_COMMAND}\nhy-workflow setup`,
      ].join("\n"),
    },
    hint: artifactSync
      ? "Stop here. Review the artifact dry-run; do not silently overwrite team files or continue workflow tools."
      : "Stop here. Ask the user to run the setup command in a terminal and restart the agent. Do not call other hy_* tools until setup has been refreshed.",
    requires_user: true,
    stop_here: true,
    allowedTools: ["hy_status"],
    blockedTools: BLOCKED_TOOLS,
    recovery: { tool: "terminal", instruction: recoveryCommand },
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
  return {
    ...result,
    setupUpdateCheck: check,
  };
}

export function createSetupGate(root = projectRoot()): () => ToolResult | null {
  return () => {
    const check = checkSetupStamp(root);
    return check.status === "current" ? null : setupUpdateRequiredResult(check);
  };
}
