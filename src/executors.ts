import { execFileSync } from "node:child_process";

export type ExecutorName = "git" | "gh";

export type ExecutorCapability = {
  executor: ExecutorName;
  available: boolean;
  authenticated?: boolean;
  version?: string;
  checkedAt: string;
  error?: string;
};

export type ExecutorCapabilities = {
  git: ExecutorCapability;
  gh: ExecutorCapability;
  internal: {
    available: false;
    enabled: false;
    reason: string;
  };
};

export type ExecutorRequirement =
  | { ok: true; executor: ExecutorCapability }
  | { ok: false; executor: ExecutorCapability; error: Record<string, unknown> };

function probe(command: string, args: string[]): { ok: boolean; output: string; error?: string; notFound?: boolean } {
  try {
    const output = execFileSync(command, args, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, output };
  } catch (e: any) {
    return {
      ok: false,
      output: e.stdout?.trim?.() ?? "",
      error: e.stderr?.trim?.() ?? e.message ?? String(e),
      notFound: e.code === "ENOENT",
    };
  }
}

function firstLine(value: string): string | undefined {
  return value.split(/\r?\n/, 1)[0]?.trim() || undefined;
}

export function detectGitCapability(): ExecutorCapability {
  const checkedAt = new Date().toISOString();
  const version = probe("git", ["--version"]);
  return version.ok
    ? { executor: "git", available: true, version: firstLine(version.output), checkedAt }
    : { executor: "git", available: false, checkedAt, error: version.error };
}

export function detectGhCapability(): ExecutorCapability {
  const checkedAt = new Date().toISOString();
  const version = probe("gh", ["--version"]);
  if (!version.ok) {
    if (version.notFound) return { executor: "gh", available: false, authenticated: false, checkedAt, error: version.error };
    // Test doubles and compatible wrappers may not implement --version. The
    // executable is present, so let the requested gh operation decide.
    return { executor: "gh", available: true, checkedAt, error: version.error };
  }

  const auth = probe("gh", ["auth", "status"]);
  return {
    executor: "gh",
    available: true,
    authenticated: auth.ok,
    version: firstLine(version.output),
    checkedAt,
    ...(auth.ok ? {} : { error: auth.error }),
  };
}

export function detectExecutorCapabilities(): ExecutorCapabilities {
  return {
    git: detectGitCapability(),
    gh: detectGhCapability(),
    internal: {
      available: false,
      enabled: false,
      reason: "No hy-internal Git or GitHub backend is implemented; missing CLI capabilities fail closed.",
    },
  };
}

let startupCapabilities: ExecutorCapabilities | null = null;

export function initializeExecutorCapabilities(): ExecutorCapabilities {
  startupCapabilities = detectExecutorCapabilities();
  return startupCapabilities;
}

export function getStartupExecutorCapabilities(): ExecutorCapabilities {
  return startupCapabilities ?? initializeExecutorCapabilities();
}

export function requireGitExecutor(): ExecutorRequirement {
  const executor = detectGitCapability();
  if (executor.available) return { ok: true, executor };
  return {
    ok: false,
    executor,
    error: {
      type: "config",
      subtype: "config_invalid",
      code: "GIT_EXECUTOR_UNAVAILABLE",
      message: "git CLI is required for this repository operation.",
      hint: "Install git, ensure it is on PATH, then retry the same hy-workflow tool.",
      detail: { executor },
      retryable: true,
    },
  };
}

export function requireGhExecutor(): ExecutorRequirement {
  const executor = detectGhCapability();
  if (executor.available && executor.authenticated !== false) return { ok: true, executor };
  const missing = !executor.available;
  return {
    ok: false,
    executor,
    error: {
      type: "config",
      subtype: "config_invalid",
      code: missing ? "GH_EXECUTOR_UNAVAILABLE" : "GH_AUTH_REQUIRED",
      message: missing ? "gh CLI is required for this GitHub operation." : "gh CLI is not authenticated.",
      hint: missing
        ? "Install GitHub CLI, run gh auth login, then retry the same hy-workflow tool."
        : "Run gh auth login or repair gh authentication, then retry the same hy-workflow tool.",
      detail: { executor },
      retryable: true,
    },
  };
}
