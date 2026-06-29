import * as fs from "node:fs";
import * as path from "node:path";
import { projectRoot, statePath, type Phase } from "./state.js";
import { toolResult, type ToolResult } from "./tools/_base.js";

export const SETUP_VERSION = "2026.06.26.1";
export const SETUP_STAMP = path.join(".git", "hy-workflow", "setup.json");
export const LEGACY_SETUP_STAMP = path.join(".hy", "hy-workflow-setup.json");
export const SETUP_COMMAND = "curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash";

export type SetupStamp = {
  schemaVersion?: string;
  setupVersion?: string;
  generatedAt?: string;
  artifacts?: string[];
};

export type SetupCheck = {
  status: "current" | "missing_stamp" | "outdated" | "unreadable";
  currentVersion: string | null;
  latestVersion: string;
  stampPath: string;
};

const BLOCKED_TOOLS = ["hy_plan", "hy_approve", "hy_branch", "hy_edit", "hy_verify", "hy_commit", "hy_ci", "hy_merge", "hy_chain"];

export function setupStampPath(root = projectRoot()): string {
  return path.join(root, SETUP_STAMP);
}

export function readSetupStamp(root = projectRoot()): SetupStamp | null {
  const filePath = setupStampPath(root);
  const legacyPath = path.join(root, LEGACY_SETUP_STAMP);
  const target = fs.existsSync(filePath) ? filePath : legacyPath;
  if (!fs.existsSync(target)) return null;
  return JSON.parse(fs.readFileSync(target, "utf-8"));
}

export function checkSetupStamp(root = projectRoot()): SetupCheck {
  const stampPath = setupStampPath(root);
  try {
    const stamp = readSetupStamp(root);
    if (!stamp?.setupVersion) {
      return { status: "missing_stamp", currentVersion: null, latestVersion: SETUP_VERSION, stampPath };
    }
    if (stamp.setupVersion !== SETUP_VERSION) {
      return { status: "outdated", currentVersion: stamp.setupVersion, latestVersion: SETUP_VERSION, stampPath };
    }
    return { status: "current", currentVersion: stamp.setupVersion, latestVersion: SETUP_VERSION, stampPath };
  } catch {
    return { status: "unreadable", currentVersion: null, latestVersion: SETUP_VERSION, stampPath };
  }
}

export function setupUpdateRequiredResult(check: SetupCheck): ToolResult {
  const phase = readCurrentPhaseReadonly();
  const reason = check.status === "outdated"
    ? `Current setup version is ${check.currentVersion}; latest is ${check.latestVersion}.`
    : check.status === "unreadable"
      ? `Setup stamp exists but could not be read: ${check.stampPath}.`
      : `Setup stamp is missing: ${check.stampPath}.`;

  return toolResult(phase, {
    error: {
      type: "setup_update_required",
      status: check.status,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      stampPath: check.stampPath,
    },
    display: {
      title: "hy-workflow setup update required",
      body: [
        "hy-workflow project bootstrap artifacts need to be installed or refreshed.",
        reason,
        "",
        "Run this command in the project root, then restart the agent/MCP session:",
        SETUP_COMMAND,
      ].join("\n"),
    },
    hint: "Stop here. Ask the user to run the setup command in a terminal and restart the agent. Do not call other hy_* tools until setup has been refreshed.",
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
  return {
    ...result,
    setupUpdateCheck: check,
  };
}

export function createSetupGate(root = projectRoot()): () => ToolResult | null {
  let checked = false;
  return () => {
    if (checked) return null;
    checked = true;
    const check = checkSetupStamp(root);
    return check.status === "current" ? null : setupUpdateRequiredResult(check);
  };
}
