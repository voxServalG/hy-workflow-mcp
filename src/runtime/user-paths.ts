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

function sameCanonicalPath(left: string, right: string): boolean {
  return canonicalRoot(left) === canonicalRoot(right);
}

/**
 * Return the transport-independent locator used by project identity.
 *
 * GitHub repository paths are case-insensitive, so folding the owner and
 * repository names is safe and prevents harmless URL spelling changes from
 * forking external workflow state. Non-GitHub remotes retain their historical
 * byte-for-byte identity until an equivalent hosting contract is explicit.
 */
export function redactGitRemote(remote: string | null): string | null {
  if (!remote) return null;
  const value = remote.trim();
  if (!value) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return value.replace(/^[^@/:\s]+@(?=[A-Za-z0-9.-]+:)/, "");
  }
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s@]*@/i, "$1");
  }
}

export function redactGitRemoteCredentialsInText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/gi, "$1")
    .replace(/(^|[\s("'=])[^\s@/:]+@(?=[A-Za-z0-9.-]+:[^\s])/g, "$1");
}

export function canonicalGitRemote(remote: string | null): string | null {
  const value = redactGitRemote(remote);
  if (!value) return null;

  let host = "";
  let repositoryPath = "";
  let port = "";
  let protocol = "";
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      const parsed = new URL(value);
      if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return value;
      protocol = parsed.protocol;
      host = parsed.hostname.toLowerCase().replace(/\.$/, "");
      port = parsed.port;
      repositoryPath = parsed.pathname;
    } else {
      const scp = value.match(/^(?:[^@/:]+@)?([A-Za-z0-9.-]+):(.+)$/);
      if (!scp) return value;
      host = scp[1].toLowerCase().replace(/\.$/, "");
      repositoryPath = scp[2];
    }
  } catch {
    return value;
  }

  if (host === "www.github.com") host = "github.com";
  if (host !== "github.com") return value;
  const defaultPort = !port
    || (protocol === "https:" && port === "443")
    || (protocol === "http:" && port === "80")
    || (protocol === "ssh:" && port === "22")
    || (protocol === "git:" && port === "9418");
  if (!defaultPort) return value;

  const cleanPath = repositoryPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const segments = cleanPath.split("/");
  if (segments.length !== 2 || segments.some(segment => !/^[A-Za-z0-9_.-]+$/.test(segment))) return value;
  return "github.com/" + segments[0].toLowerCase() + "/" + segments[1].toLowerCase();
}

/**
 * Compare a persisted identity with the checkout that is currently active.
 *
 * The project id remains the storage key, paths are compared through realpath
 * so a symlink does not fork state, and only the explicitly supported remote
 * canonicalization contract is accepted. A moved checkout deliberately fails
 * this predicate until helper install reconciles its persisted identity.
 */
export function sameProjectCheckoutIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
  return left.id === right.id
    && sameCanonicalPath(left.root, right.root)
    && sameCanonicalPath(left.gitCommonDir, right.gitCommonDir)
    && canonicalGitRemote(left.remote) === canonicalGitRemote(right.remote);
}

type StoredIdentity = ProjectIdentity & { source: "registry" | "deployment" };

function identityConflict(message: string, detail: Record<string, unknown>): never {
  const error = new Error(message) as Error & { code: string; detail: Record<string, unknown> };
  error.name = "ProjectIdentityConflictError";
  error.code = "PROJECT_IDENTITY_CONFLICT";
  error.detail = detail;
  throw error;
}

function storedIdentities(roots: UserRoots): StoredIdentity[] {
  const values = new Map<string, StoredIdentity>();
  const file = path.join(roots.config, "registry.json");
  if (fs.existsSync(file)) {
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf-8"));
      if (value?.projects && typeof value.projects === "object") {
        for (const [id, raw] of Object.entries(value.projects as Record<string, any>)) {
          const record = raw as Record<string, unknown>;
          if (!/^[a-f0-9]{24}$/.test(id)
              || record.id !== id
              || typeof record.root !== "string"
              || typeof record.gitCommonDir !== "string"
              || (record.remote !== null && typeof record.remote !== "string")) continue;
          values.set(id, {
            id,
            root: record.root,
            gitCommonDir: record.gitCommonDir,
            remote: record.remote as string | null,
            source: "registry",
          });
        }
      }
    } catch {
      // runtime/deployment performs strict registry validation. Identity lookup
      // must never replace or reinterpret an unreadable registry.
    }
  }

  const projectsDir = path.join(roots.state, "projects");
  if (!fs.existsSync(projectsDir)) return [...values.values()];
  for (const id of fs.readdirSync(projectsDir)) {
    if (!/^[a-f0-9]{24}$/.test(id)) continue;
    const deployment = path.join(projectsDir, id, "deployment.json");
    if (!fs.existsSync(deployment)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(deployment, "utf-8"));
      const identity = parsed?.identity as Record<string, unknown> | undefined;
      if (!identity
          || identity.id !== id
          || typeof identity.root !== "string"
          || typeof identity.gitCommonDir !== "string"
          || (identity.remote !== null && typeof identity.remote !== "string")) continue;
      const candidate: StoredIdentity = {
        id,
        root: identity.root,
        gitCommonDir: identity.gitCommonDir,
        remote: identity.remote as string | null,
        source: "deployment",
      };
      const registered = values.get(id);
      const mismatchedFields = registered ? [
        ...(registered.root !== candidate.root ? ["root"] : []),
        ...(registered.gitCommonDir !== candidate.gitCommonDir ? ["gitCommonDir"] : []),
        ...(registered.remote !== candidate.remote ? ["remote"] : []),
      ] : [];
      if (registered && mismatchedFields.length) {
        identityConflict("Registry and deployment identities disagree for one stored project.", {
          projectId: id,
          mismatchedFields,
        });
      }
      values.set(id, candidate);
    } catch (error) {
      if ((error as any)?.code === "PROJECT_IDENTITY_CONFLICT") throw error;
      // An unrelated unreadable deployment remains the responsibility of setup
      // doctor. It must not be guessed into the current repository identity.
    }
  }
  return [...values.values()];
}

function hasStoredProject(id: string, roots: UserRoots): boolean {
  const storage = projectStoragePaths(id, roots);
  return [storage.configDir, storage.stateDir, storage.cacheDir].some(directory => fs.existsSync(directory));
}

function legacyIdentityAlias(identity: ProjectIdentity, roots: UserRoots): ProjectIdentity | null {
  if (!identity.remote) return null;
  const identities = storedIdentities(roots);
  const targetStored = identities.some(candidate => candidate.id === identity.id) || hasStoredProject(identity.id, roots);
  const equivalent = identities.filter(candidate =>
    candidate.id !== identity.id
    && canonicalGitRemote(candidate.remote) === identity.remote,
  );
  const sameCheckout = equivalent.filter(candidate =>
    sameCanonicalPath(candidate.root, identity.root)
      && sameCanonicalPath(candidate.gitCommonDir, identity.gitCommonDir)
      && hasStoredProject(candidate.id, roots),
  );
  const movedCheckout = equivalent.filter(candidate =>
    !fs.existsSync(candidate.root) && hasStoredProject(candidate.id, roots),
  );
  const activeLegacy = sameCheckout.length ? sameCheckout : movedCheckout;

  if (targetStored && activeLegacy.length) {
    identityConflict("Canonical and legacy project identities both contain active external state.", {
      canonicalProjectId: identity.id,
      legacyProjectIds: activeLegacy.map(candidate => candidate.id),
    });
  }
  if (activeLegacy.length > 1) {
    identityConflict("Multiple legacy project identities contain active external state for the same repository.", {
      canonicalProjectId: identity.id,
      legacyProjectIds: activeLegacy.map(candidate => candidate.id),
    });
  }
  if (targetStored || !activeLegacy.length) return null;

  const legacy = activeLegacy[0];
  if (sameCheckout.length) {
    // Read-only alias: every identity-scoped artifact continues to resolve as
    // one set, so phase, approval, scope, exam cache, and DocsGraph cannot be
    // partially copied or lost during a transport-only remote change. Return
    // the active canonical identity while retaining only the legacy storage id;
    // public status must never project a credential-bearing stored remote.
    return { ...identity, id: legacy.id };
  }
  // Preserve the historical moved-checkout recovery behavior. A subsequent
  // setup/unset transaction will reconcile the stored root under this id.
  return { ...identity, id: legacy.id };
}

export function resolveProjectIdentity(root: string, roots = userRoots()): ProjectIdentity {
  const canonical = canonicalRoot(root);
  const commonRaw = git(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ?? git(canonical, ["rev-parse", "--git-common-dir"])
    ?? path.join(canonical, ".git");
  const gitCommonDir = path.isAbsolute(commonRaw) ? canonicalRoot(commonRaw) : canonicalRoot(path.join(canonical, commonRaw));
  const remote = canonicalGitRemote(git(canonical, ["remote", "get-url", "origin"]));
  const fingerprint = JSON.stringify({ root: canonical, gitCommonDir, remote: remote ?? "" });
  const generated = createHash("sha256").update(fingerprint).digest("hex").slice(0, 24);
  const provisional = { id: generated, root: canonical, gitCommonDir, remote };
  return legacyIdentityAlias(provisional, roots) ?? provisional;
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
