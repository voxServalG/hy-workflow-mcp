import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type UserRoots = {
  config: string;
  state: string;
  cache: string;
};

export type ProjectIdentity = {
  id: string;
  root: string;
  gitCommonDir: string;
  remote: string | null;
};

export type ProjectPaths = {
  identity: ProjectIdentity;
  registry: string;
  clientOwnership: string;
  configDir: string;
  config: string;
  stateDir: string;
  deployment: string;
  workflowState: string;
  scope: string;
  cacheDir: string;
  docsGraph: string;
};

type RootOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
};

function absolute(value: string): string {
  return path.resolve(value);
}

export function userRoots(options: RootOptions = {}): UserRoots {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();

  if (env.HY_WORKFLOW_CONFIG_HOME || env.HY_WORKFLOW_STATE_HOME || env.HY_WORKFLOW_CACHE_HOME) {
    return {
      config: absolute(env.HY_WORKFLOW_CONFIG_HOME ?? path.join(home, ".config", "hy-workflow")),
      state: absolute(env.HY_WORKFLOW_STATE_HOME ?? path.join(home, ".local", "state", "hy-workflow")),
      cache: absolute(env.HY_WORKFLOW_CACHE_HOME ?? path.join(home, ".cache", "hy-workflow")),
    };
  }

  if (platform === "win32") {
    const roaming = env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const local = env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return {
      config: path.join(roaming, "hy-workflow"),
      state: path.join(local, "hy-workflow", "state"),
      cache: path.join(local, "hy-workflow", "cache"),
    };
  }

  if (platform === "darwin") {
    return {
      config: path.join(home, "Library", "Application Support", "hy-workflow"),
      state: path.join(home, "Library", "Application Support", "hy-workflow", "state"),
      cache: path.join(home, "Library", "Caches", "hy-workflow"),
    };
  }

  return {
    config: path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "hy-workflow"),
    state: path.join(env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "hy-workflow"),
    cache: path.join(env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "hy-workflow"),
  };
}

function git(root: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

export function resolveProjectIdentity(root: string): ProjectIdentity {
  const canonical = canonicalRoot(root);
  const commonRaw = git(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ?? git(canonical, ["rev-parse", "--git-common-dir"])
    ?? path.join(canonical, ".git");
  const gitCommonDir = path.isAbsolute(commonRaw) ? canonicalRoot(commonRaw) : canonicalRoot(path.join(canonical, commonRaw));
  const remote = git(canonical, ["remote", "get-url", "origin"]);
  const fingerprint = JSON.stringify({ root: canonical, gitCommonDir, remote: remote ?? "" });
  const id = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  return { id, root: canonical, gitCommonDir, remote };
}

export function projectPaths(root: string, roots = userRoots()): ProjectPaths {
  const identity = resolveProjectIdentity(root);
  const configDir = path.join(roots.config, "projects", identity.id);
  const stateDir = path.join(roots.state, "projects", identity.id);
  const cacheDir = path.join(roots.cache, "projects", identity.id);
  return {
    identity,
    registry: path.join(roots.config, "registry.json"),
    clientOwnership: path.join(roots.state, "client-ownership.json"),
    configDir,
    config: path.join(configDir, "config.json"),
    stateDir,
    deployment: path.join(stateDir, "deployment.json"),
    workflowState: path.join(stateDir, "workflow.json"),
    scope: path.join(stateDir, "scope.json"),
    cacheDir,
    docsGraph: path.join(cacheDir, "docs-graph.json"),
  };
}

export function ensureParent(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function atomicWriteJson(filePath: string, value: unknown): void {
  ensureParent(filePath);
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
}
