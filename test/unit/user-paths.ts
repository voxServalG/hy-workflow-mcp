import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeGitProject } from "../helpers/runtime-home.js";
import { resolveOriginRepository } from "../../src/git.js";
import { canonicalGitRemote, projectPaths, projectStoragePaths, redactGitRemote, redactGitRemoteCredentialsInText, resolveProjectIdentity, userRoots } from "../../src/runtime/user-paths.js";

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

const linux = userRoots({ platform: "linux", home: "/home/demo", env: {} });
assert(linux.config === path.join("/home/demo", ".config", "hy-workflow"), "Linux config should follow XDG defaults");
const windows = userRoots({ platform: "win32", home: "C:\\Users\\demo", env: { APPDATA: "C:\\Roaming", LOCALAPPDATA: "C:\\Local" } });
assert(windows.config.includes("Roaming") && windows.state.includes("Local"), "Windows roots should use roaming config and local state");
const mac = userRoots({ platform: "darwin", home: "/Users/demo", env: {} });
assert(mac.config.includes("Application Support") && mac.cache.includes("Library"), "macOS roots should use Library directories");
const overridden = userRoots({ env: { HY_WORKFLOW_CONFIG_HOME: "/tmp/c", HY_WORKFLOW_STATE_HOME: "/tmp/s", HY_WORKFLOW_CACHE_HOME: "/tmp/k" } });
assert(overridden.config === "/tmp/c" && overridden.state === "/tmp/s" && overridden.cache === "/tmp/k", "explicit runtime roots should win");

const root = makeGitProject("hy-user-paths-");
const identity = resolveProjectIdentity(root);
assert(identity.id === resolveProjectIdentity(root).id, "project identity should be stable");
const paths = projectPaths(root, { config: "/tmp/hy-c", state: "/tmp/hy-s", cache: "/tmp/hy-k" });
assert(paths.config.startsWith("/tmp/hy-c/") && paths.workflowState.startsWith("/tmp/hy-s/") && paths.docsGraph.startsWith("/tmp/hy-k/"), "project artifacts should be partitioned by user roots");
assert(!Object.values(paths).filter(value => typeof value === "string").some(value => value.startsWith(root)), "runtime artifact paths must stay outside the project root");

const githubForms = [
  "git@github.com:VoxServalG/Hy-Workflow-Mcp.git",
  "ssh://git@github.com:22/VoxServalG/Hy-Workflow-Mcp.git",
  "https://github.com/VoxServalG/Hy-Workflow-Mcp.git",
  "https://GITHUB.COM/VoxServalG/Hy-Workflow-Mcp/",
  "https://www.github.com/VoxServalG/Hy-Workflow-Mcp",
];
assert(
  githubForms.every(remote => canonicalGitRemote(remote) === "github.com/voxservalg/hy-workflow-mcp"),
  "SSH, HTTPS, default port, suffix, slash, and GitHub hostname casing must share one locator",
);
assert(
  canonicalGitRemote("https://github.com/other/hy-workflow-mcp.git") !== canonicalGitRemote(githubForms[0]),
  "different GitHub owners must not collide",
);
const credentialRemote = "https://agent:very-secret-token@example.invalid/org/repository.git";
const publicRemote = redactGitRemote(credentialRemote);
assert(publicRemote === "https://example.invalid/org/repository.git", "URL userinfo must be removed from non-GitHub public remotes");
assert(
  canonicalGitRemote("https://agent:very-secret-token@github.com/VoxServalG/Hy-Workflow-Mcp.git")
    === "github.com/voxservalg/hy-workflow-mcp",
  "credential-bearing GitHub URLs must canonicalize without retaining userinfo",
);
assert(
  redactGitRemoteCredentialsInText(`failed for ${credentialRemote}`)
    === "failed for https://example.invalid/org/repository.git",
  "credential-bearing remotes echoed inside diagnostics must be redacted",
);
const multiAtCredentialRemote = "https://agent:segment@hidden@example.invalid/org/repository.git";
assert(
  redactGitRemoteCredentialsInText(`failed for ${multiAtCredentialRemote}`) === "failed for https://example.invalid/org/repository.git",
  "URL userinfo containing an at sign must be redacted through the final authority delimiter",
);


const credentialErrorRoot = makeGitProject("hy-credential-remote-error-");
execFileSync("git", ["remote", "add", "origin", "https://agent:very-secret-token@example.invalid/single.git"], { cwd: credentialErrorRoot });
const unresolvedCredentialRemote = resolveOriginRepository(credentialErrorRoot);
assert(!unresolvedCredentialRemote.ok, "an unresolvable credential-bearing remote must fail closed");
const publicError = JSON.stringify(unresolvedCredentialRemote);
assert(!publicError.includes("agent") && !publicError.includes("very-secret-token"), "origin resolution error facts must not expose URL userinfo");
assert(publicError.includes("https://example.invalid/single.git"), "origin resolution should retain a useful redacted URL fact");


const canonicalRoot = makeGitProject("hy-canonical-remote-");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-canonical-runtime-"));
const canonicalRoots = {
  config: path.join(runtime, "config"),
  state: path.join(runtime, "state"),
  cache: path.join(runtime, "cache"),
};
execFileSync("git", ["remote", "add", "origin", githubForms[0]], { cwd: canonicalRoot });
const canonicalIds = githubForms.map(remote => {
  execFileSync("git", ["remote", "set-url", "origin", remote], { cwd: canonicalRoot });
  return resolveProjectIdentity(canonicalRoot, canonicalRoots).id;
});
assert(new Set(canonicalIds).size === 1, "equivalent GitHub origin spellings must produce one project id");

const canonicalIdentity = resolveProjectIdentity(canonicalRoot, canonicalRoots);
const legacyRemote = "git@github.com:VoxServalG/Hy-Workflow-Mcp.git";
const legacyId = createHash("sha256").update(JSON.stringify({
  root: canonicalIdentity.root,
  gitCommonDir: canonicalIdentity.gitCommonDir,
  remote: legacyRemote,
})).digest("hex").slice(0, 24);
const legacyStorage = projectStoragePaths(legacyId, canonicalRoots);
fs.mkdirSync(legacyStorage.configDir, { recursive: true });
fs.mkdirSync(legacyStorage.stateDir, { recursive: true });
fs.mkdirSync(legacyStorage.cacheDir, { recursive: true });
fs.writeFileSync(legacyStorage.config, "{\"profile\":\"legacy\"}\n");
fs.writeFileSync(legacyStorage.workflowState, "{\"phase\":\"commit\",\"approval\":{\"note\":\"preserved\"}}\n");
fs.writeFileSync(legacyStorage.scope, "{\"files\":[\"src/index.ts\"]}\n");
fs.writeFileSync(legacyStorage.docsGraph, "{\"digest\":\"preserved\"}\n");
const legacyIdentity = { ...canonicalIdentity, id: legacyId, remote: legacyRemote };
fs.writeFileSync(legacyStorage.deployment, JSON.stringify({ schemaVersion: "3", identity: legacyIdentity }) + "\n");
fs.mkdirSync(canonicalRoots.config, { recursive: true });
const registry = {
  schemaVersion: "1",
  revision: 1,
  projects: {
    [legacyId]: { ...legacyIdentity, mode: "shared", clients: [], updatedAt: "2026-07-31T00:00:00.000Z" },
  },
};
fs.writeFileSync(path.join(canonicalRoots.config, "registry.json"), JSON.stringify(registry) + "\n");
execFileSync("git", ["remote", "set-url", "origin", "https://github.com/VoxServalG/Hy-Workflow-Mcp.git"], { cwd: canonicalRoot });
const aliased = projectPaths(canonicalRoot, canonicalRoots);
assert(aliased.identity.id === legacyId, "one active raw-URL identity must be aliased without forking state");
assert(fs.readFileSync(aliased.workflowState, "utf-8").includes("\"commit\""), "legacy workflow phase and approval must remain accessible");
assert(fs.existsSync(aliased.config) && fs.existsSync(aliased.scope) && fs.existsSync(aliased.docsGraph), "config, scope, and DocsGraph must resolve through the same alias");

const conflictingRemote = "ssh://git@github.com/VoxServalG/Hy-Workflow-Mcp.git";
const conflictingId = createHash("sha256").update(JSON.stringify({
  root: canonicalIdentity.root,
  gitCommonDir: canonicalIdentity.gitCommonDir,
  remote: conflictingRemote,
})).digest("hex").slice(0, 24);
const conflictingStorage = projectStoragePaths(conflictingId, canonicalRoots);
fs.mkdirSync(conflictingStorage.stateDir, { recursive: true });
const conflictingIdentity = { ...canonicalIdentity, id: conflictingId, remote: conflictingRemote };
fs.writeFileSync(conflictingStorage.deployment, JSON.stringify({ schemaVersion: "3", identity: conflictingIdentity }) + "\n");
registry.projects[conflictingId] = { ...conflictingIdentity, mode: "shared", clients: [], updatedAt: "2026-07-31T00:00:01.000Z" };
fs.writeFileSync(path.join(canonicalRoots.config, "registry.json"), JSON.stringify(registry) + "\n");
let conflictCode = "";
try {
  projectPaths(canonicalRoot, canonicalRoots);
} catch (error: any) {
  conflictCode = error?.code ?? "";
}
assert(conflictCode === "PROJECT_IDENTITY_CONFLICT", "multiple active equivalent legacy identities must fail closed explicitly");
