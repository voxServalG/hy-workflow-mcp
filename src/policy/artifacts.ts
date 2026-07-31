import { MINIMAL_PROJECT_CONTRACT, readDeployment } from "../runtime/deployment.js";

export const NEW_PROJECT_ARTIFACTS = [
  ".github/workflows/hy-workflow.yml",
  "hy-workflow.json",
] as const;

export const TRACKED_PROJECT_ARTIFACTS = NEW_PROJECT_ARTIFACTS;

export const LOCAL_RUNTIME_ARTIFACTS = [
  ".hy/",
] as const;

export const LEGACY_IGNORED_ARTIFACTS = [
  ".git/hy-workflow/",
  ".opencode/",
  ".codex/",
  ".mcp.json",
  "codelint.json",
  "doclint.json",
  "docs-gardener.json",
  "AGENTS.md",
] as const;

export function isLocalArtifact(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return LOCAL_RUNTIME_ARTIFACTS.some(pattern => {
    if (pattern.endsWith("/")) return normalized === pattern.slice(0, -1) || normalized.startsWith(pattern);
    return normalized === pattern;
  });
}

export function isLegacyIgnoredArtifact(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return LEGACY_IGNORED_ARTIFACTS.some(pattern => {
    if (pattern.endsWith("/")) return normalized === pattern.slice(0, -1) || normalized.startsWith(pattern);
    return normalized === pattern;
  });
}

export function isNewProjectArtifact(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return NEW_PROJECT_ARTIFACTS.some(pattern => normalized === pattern);
}

export type ProjectArtifactAuthority = "fresh" | "minimal-v1" | "legacy-inert";

/**
 * Artifact authority comes only from the external deployment manifest. Project
 * files are deliberately not sampled while deciding whether they are legacy.
 */
export function projectArtifactAuthority(root: string): ProjectArtifactAuthority {
  try {
    const deployment = readDeployment(root);
    if (!deployment) return "fresh";
    return deployment.schemaVersion === "3" && deployment.projectContract === MINIMAL_PROJECT_CONTRACT
      ? "minimal-v1"
      : "legacy-inert";
  } catch {
    // The setup/runtime gate reports unreadable external state. Without the
    // exact minimal-v1 marker, project files never become authority.
    return "fresh";
  }
}

export function isRuntimeIgnoredArtifact(root: string, file: string): boolean {
  return isLocalArtifact(file)
    || isLegacyIgnoredArtifact(file)
    || (isNewProjectArtifact(file) && projectArtifactAuthority(root) !== "minimal-v1");
}

export function runtimeArtifactExclusionPathspecs(root: string): string[] {
  const patterns = [
    ".hy/**",
    ".opencode/**",
    ".codex/**",
    ".mcp.json",
    "codelint.json",
    "doclint.json",
    "docs-gardener.json",
    "AGENTS.md",
    ...(projectArtifactAuthority(root) === "minimal-v1" ? [] : [...NEW_PROJECT_ARTIFACTS]),
  ];
  return [...new Set(patterns)].map(pattern => ":(exclude)" + pattern);
}
