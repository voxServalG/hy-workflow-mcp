export const TRACKED_PROJECT_ARTIFACTS = [
  ".github/",
  "AGENTS.md",
  ".gitignore",
  "hy-workflow.json",
] as const;

export const LOCAL_RUNTIME_ARTIFACTS = [
  ".hy/",
  ".opencode/",
  ".codex/",
  ".mcp.json",
  "codelint.json",
  "doclint.json",
  "docs-gardener.json",
] as const;

export const COMPAT_CONFIG_FILES = [
  "codelint.json",
  "doclint.json",
  "docs-gardener.json",
] as const;

export function isLocalArtifact(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  return LOCAL_RUNTIME_ARTIFACTS.some(pattern => {
    if (pattern.endsWith("/")) return normalized === pattern.slice(0, -1) || normalized.startsWith(pattern);
    return normalized === pattern;
  });
}

