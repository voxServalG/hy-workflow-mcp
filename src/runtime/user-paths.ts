import { createHash, randomUUID } from "node:crypto";
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

export type ProjectStoragePaths = {
  configDir: string;
  config: string;
  stateDir: string;
  deployment: string;
  workflowState: string;
  scope: string;
  cacheDir: string;
  docsGraph: string;
};

export type ProjectPaths = ProjectStoragePaths & {
  identity: ProjectIdentity;
  registry: string;
  clientOwnership: string;
  setupLock: string;
  setupJournal: string;
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

function movedRegistryId(identity: ProjectIdentity, roots: UserRoots): string | null {
  if (!identity.remote) return null;
  const file = path.join(roots.config, "registry.json");
  if (!fs.existsSync(file)) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!value?.projects || typeof value.projects !== "object") return null;
    const candidates = Object.values(value.projects as Record<string, any>).filter(record =>
      record?.remote === identity.remote && typeof record?.root === "string" && !fs.existsSync(record.root),
    );
    return candidates.length === 1 && typeof (candidates[0] as any).id === "string" ? (candidates[0] as any).id : null;
  } catch {
    // Strict registry validation happens in runtime/deployment. Identity lookup must not
    // overwrite or reinterpret an unreadable registry.
    return null;
  }
}

export function resolveProjectIdentity(root: string, roots = userRoots()): ProjectIdentity {
  const canonical = canonicalRoot(root);
  const commonRaw = git(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ?? git(canonical, ["rev-parse", "--git-common-dir"])
    ?? path.join(canonical, ".git");
  const gitCommonDir = path.isAbsolute(commonRaw) ? canonicalRoot(commonRaw) : canonicalRoot(path.join(canonical, commonRaw));
  const remote = git(canonical, ["remote", "get-url", "origin"]);
  const fingerprint = JSON.stringify({ root: canonical, gitCommonDir, remote: remote ?? "" });
  const generated = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  const provisional = { id: generated, root: canonical, gitCommonDir, remote };
  const id = movedRegistryId(provisional, roots) ?? generated;
  return { id, root: canonical, gitCommonDir, remote };
}

export function projectPaths(root: string, roots = userRoots()): ProjectPaths {
  const identity = resolveProjectIdentity(root, roots);
  const storage = projectStoragePaths(identity.id, roots);
  return {
    ...storage,
    identity,
    registry: path.join(roots.config, "registry.json"),
    clientOwnership: path.join(roots.state, "client-ownership.json"),
    setupLock: path.join(roots.state, "setup.lock"),
    setupJournal: path.join(roots.state, "setup-journal.json"),
  };
}

export function projectStoragePaths(projectId: string, roots = userRoots()): ProjectStoragePaths {
  if (!/^[a-f0-9]{24}$/.test(projectId)) throw new Error(`Invalid hy-workflow project id: ${projectId}`);
  const configDir = path.join(roots.config, "projects", projectId);
  const stateDir = path.join(roots.state, "projects", projectId);
  const cacheDir = path.join(roots.cache, "projects", projectId);
  return {
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
  atomicWriteText(filePath, JSON.stringify(value, null, 2) + "\n");
}

export function atomicWriteText(filePath: string, value: string, defaultMode = 0o600): void {
  ensureParent(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const mode = fs.existsSync(filePath) ? fs.statSync(filePath).mode & 0o777 : defaultMode;
  try {
    fs.writeFileSync(temporary, value, { encoding: "utf-8", mode, flag: "wx" });
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}
