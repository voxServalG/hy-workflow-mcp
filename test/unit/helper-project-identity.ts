import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSetupStamp } from "../../src/bootstrap.js";
import { runHelperCli } from "../../src/helper/cli.js";
import { getHelperProjectStatus, registerHelperProject } from "../../src/helper/project.js";
import type { DetectedHelperSkillTarget, HelperSkillPaths } from "../../src/helper/skills.js";
import {
  canonicalGitRemote,
  projectPaths,
  projectStoragePaths,
  resolveProjectIdentity,
  userRoots,
} from "../../src/runtime/user-paths.js";
import { setSetupTestHooks } from "../helpers/setup-hooks.js";
import { gitStatus, makeGitProject } from "../helpers/runtime-home.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function setRuntimeRoots(base: string): void {
  process.env.HY_WORKFLOW_CONFIG_HOME = path.join(base, "config");
  process.env.HY_WORKFLOW_STATE_HOME = path.join(base, "state");
  process.env.HY_WORKFLOW_CACHE_HOME = path.join(base, "cache");
}

function skillPathsFor(base: string): HelperSkillPaths {
  const dataRoot = path.join(base, "skill-data");
  const stateRoot = path.join(base, "skill-state");
  return {
    dataRoot,
    stateRoot,
    ssotRoot: path.join(dataRoot, "skills"),
    manifestPath: path.join(stateRoot, "skill-ownership.json"),
    lockPath: path.join(stateRoot, "skill-projector.lock"),
  };
}

function detectedCodex(base: string): DetectedHelperSkillTarget {
  return {
    agent: "codex",
    skillsDir: path.join(base, "agent-codex", "skills"),
    detected: true,
    evidence: ["test"],
  };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function readBytes(file: string): Buffer | null {
  return fs.existsSync(file) ? fs.readFileSync(file) : null;
}

function snapshot(files: readonly string[]): Map<string, Buffer | null> {
  return new Map(files.map(file => [file, readBytes(file)]));
}

function assertSnapshot(actualFiles: readonly string[], expected: Map<string, Buffer | null>, message: string): void {
  for (const file of actualFiles) {
    const before = expected.get(file) ?? null;
    const after = readBytes(file);
    assert(
      after === null ? before === null : before !== null && after.equals(before),
      message + ": " + file,
    );
  }
}

function v04Id(root: string, gitCommonDir: string, rawRemote: string): string {
  return createHash("sha256").update(JSON.stringify({
    root,
    gitCommonDir,
    remote: rawRemote,
  })).digest("hex").slice(0, 24);
}

function canonicalIdForCheckout(root: string, remote: string): string {
  const canonicalRoot = fs.realpathSync.native(root);
  const commonRaw = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: canonicalRoot, encoding: "utf8" },
  ).trim();
  const gitCommonDir = fs.realpathSync.native(commonRaw);
  return createHash("sha256").update(JSON.stringify({
    root: canonicalRoot,
    gitCommonDir,
    remote: canonicalGitRemote(remote) ?? "",
  })).digest("hex").slice(0, 24);
}

type LegacyFixture = ReturnType<typeof seedLegacyState>;

function seedLegacyState(root: string, rawRemote: string) {
  const canonical = resolveProjectIdentity(root);
  const legacyId = v04Id(canonical.root, canonical.gitCommonDir, rawRemote);
  assert(legacyId !== canonical.id, "credential-bearing v0.4 remote must produce a distinct legacy storage id");
  const storage = projectStoragePaths(legacyId);
  const registryPath = path.join(userRoots().config, "registry.json");
  const ownershipPath = path.join(userRoots().state, "client-ownership.json");
  const createdAt = "2026-07-01T00:00:00.000Z";
  const updatedAt = "2026-07-02T00:00:00.000Z";
  const identity = {
    id: legacyId,
    root: canonical.root,
    gitCommonDir: canonical.gitCommonDir,
    remote: rawRemote,
  };
  const deployment = {
    schemaVersion: "3",
    setupVersion: "2026.07.16.1",
    createdAt,
    updatedAt,
    identity,
    mode: "shared",
    clients: ["codex"],
    projectFiles: [],
    tools: {},
    artifacts: {},
    unknownDeployment: { preserve: "deployment" },
  };
  const registry = {
    schemaVersion: "1",
    revision: 17,
    projects: {
      [legacyId]: {
        ...identity,
        mode: "shared",
        clients: ["codex"],
        updatedAt,
        unknownRecord: { preserve: "record" },
      },
    },
    unknownRegistry: { preserve: "registry" },
  };
  const config = {
    project: { baseBranch: "main", codeExt: ".ts", codeDirs: ["src"], docsDir: "docs" },
    codelint: { lintDirs: ["src"], maxLines: 500 },
    doclint: { maxLines: 200 },
    docsGardener: { catalogs: {} },
    ci: { commands: ["npm test"] },
  };
  const ownership = {
    schemaVersion: "1",
    revision: 23,
    clients: { codex: {} },
    unknownOwnership: { preserve: "ownership" },
  };

  writeJson(storage.config, config);
  writeJson(storage.deployment, deployment);
  writeJson(storage.workflowState, {
    schemaVersion: "1",
    phase: "verify",
    approval: { decision: "approved", planHash: "preserve" },
  });
  writeJson(storage.scope, { schemaVersion: "1", files: ["src/index.ts"] });
  writeJson(storage.docsGraph, { schemaVersion: "1", nodes: ["docs/index.md"] });
  writeJson(registryPath, registry);
  writeJson(ownershipPath, ownership);
  return {
    legacyId,
    canonicalId: canonical.id,
    storage,
    registryPath,
    ownershipPath,
    identity,
    deployment,
    registry,
  };
}

function withoutIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const { identity: _identity, ...rest } = value;
  return rest;
}

function withoutRegistryIdentity(value: Record<string, unknown>): Record<string, unknown> {
  const {
    id: _id,
    root: _root,
    gitCommonDir: _gitCommonDir,
    remote: _remote,
    ...rest
  } = value;
  return rest;
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bundleRoot = path.join(repositoryRoot, "skills");
const secret = "sentinel-remote-secret-6d34";
const user = "sentinel-user";
const rawRemote = "https://" + user + ":" + secret
  + "@github.com/VoxServalG/Hy-Workflow-Mcp.git";

const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-identity-runtime-"));
setRuntimeRoots(runtime);
const originalRoot = makeGitProject("hy-helper-identity-project-");
execFileSync("git", ["remote", "add", "origin", rawRemote], { cwd: originalRoot });
const fixture: LegacyFixture = seedLegacyState(originalRoot, rawRemote);
const externalFiles = [
  fixture.storage.config,
  fixture.storage.deployment,
  fixture.registryPath,
  fixture.storage.workflowState,
  fixture.storage.scope,
  fixture.storage.docsGraph,
  fixture.ownershipPath,
];
const preservedOpaqueFiles = [
  fixture.storage.config,
  fixture.storage.workflowState,
  fixture.storage.scope,
  fixture.storage.docsGraph,
  fixture.ownershipPath,
];
const skillPaths = skillPathsFor(runtime);
const statusDependencies = { cwd: originalRoot, bundleRoot, skillPaths };

const sameCheckoutBefore = snapshot(externalFiles);
const sameCheckoutStatus = await runHelperCli(["status", "--json"], statusDependencies);
assert(
  sameCheckoutStatus.envelope.layers.project.status === "registered",
  "equivalent remote spelling in the same checkout must preserve registration",
);
assert(
  !sameCheckoutStatus.stdout.includes(secret) && !sameCheckoutStatus.stdout.includes(user),
  "same-checkout helper output must not expose legacy URL userinfo",
);
assertSnapshot(externalFiles, sameCheckoutBefore, "same-checkout status must preserve every external byte");

const movedRoot = originalRoot + "-moved";
fs.renameSync(originalRoot, movedRoot);
if (process.platform !== "win32") {
  fs.symlinkSync(movedRoot, originalRoot, "dir");
  const symlinkBefore = snapshot(externalFiles);
  const symlinkStatus = getHelperProjectStatus(movedRoot);
  assert(symlinkStatus.state === "registered", "realpath-equivalent checkout move must stay registered");
  assertSnapshot(externalFiles, symlinkBefore, "realpath-equivalent status must be read-only");
  fs.unlinkSync(originalRoot);
}

const gitBefore = gitStatus(movedRoot);
const movedBefore = snapshot(externalFiles);
const movedStatus = await runHelperCli(["status", "--json"], {
  ...statusDependencies,
  cwd: movedRoot,
});
assert(movedStatus.exitCode === 1 && movedStatus.envelope.status === "attention", "moved checkout status must return attention");
assert(
  movedStatus.envelope.error?.code === "HELPER_PROJECT_IDENTITY_RECONCILIATION_REQUIRED",
  "moved checkout status must expose a stable reconciliation reason",
);
assert(
  JSON.stringify(movedStatus.envelope.recovery?.argv)
    === JSON.stringify(["hy-workflow", "helper", "install", "--json"]),
  "moved checkout status must route exactly to helper install --json",
);
assert(
  !movedStatus.stdout.includes(secret) && !movedStatus.stdout.includes(user),
  "moved-checkout status must not expose legacy URL userinfo",
);
assertSnapshot(externalFiles, movedBefore, "moved-checkout status must not mutate state");
assert(gitStatus(movedRoot) === gitBefore, "moved-checkout status must not mutate the worktree");

const installDependencies = {
  cwd: movedRoot,
  bundleRoot,
  skillPaths,
  detectedTargets: [detectedCodex(runtime)],
  skillHooks: { createSymlink: () => { throw new Error("force deterministic copy"); } },
};
const restoreHooks = setSetupTestHooks({ failAt: "registry" });
let failedInstall;
try {
  failedInstall = await runHelperCli(
    ["install", "--clients", "codex", "--mode", "copy", "--json"],
    installDependencies,
  );
} finally {
  restoreHooks();
}
assert(failedInstall.exitCode === 1 && failedInstall.envelope.status === "partial", "injected registry failure must be partial after Skill installation");
assert(
  failedInstall.envelope.error?.code === "SETUP_TRANSACTION_FAILED",
  "identity reconciliation failure must keep the transaction error code",
);
assert(
  !failedInstall.stdout.includes(secret) && !failedInstall.stdout.includes(user),
  "failed reconciliation output must not expose legacy URL userinfo",
);
assertSnapshot(externalFiles, movedBefore, "failed identity reconciliation must roll back exact external bytes");
const movedPathsBefore = projectPaths(movedRoot);
assert(!fs.existsSync(movedPathsBefore.setupJournal), "failed reconciliation must remove a fully recovered journal");
assert(!fs.existsSync(movedPathsBefore.setupLock), "failed reconciliation must release its lock");
assert(gitStatus(movedRoot) === gitBefore, "failed reconciliation must not mutate the worktree");

const canonicalMovedId = canonicalIdForCheckout(movedRoot, rawRemote);
assert(canonicalMovedId !== fixture.legacyId, "moved checkout must have a distinct canonical id before aliasing");
for (const directory of [
  projectStoragePaths(canonicalMovedId).configDir,
  projectStoragePaths(canonicalMovedId).stateDir,
  projectStoragePaths(canonicalMovedId).cacheDir,
]) {
  assert(!fs.existsSync(directory), "reconciliation must never fork state into the canonical id");
}

const success = await runHelperCli(
  ["install", "--clients", "codex", "--mode", "copy", "--json"],
  installDependencies,
);
assert(success.exitCode === 0 && success.envelope.status === "completed", "safe moved-checkout install must complete");
assert(success.envelope.layers.project.status === "preserved", "moved-checkout state must remain a preserved registration");
assert(
  JSON.stringify(success.envelope.layers.project.localFilesChanged)
    === JSON.stringify([fixture.storage.deployment, fixture.registryPath]),
  "successful reconciliation must report exactly deployment and registry identity writes",
);
assert(
  !success.stdout.includes(secret) && !success.stdout.includes(user),
  "successful reconciliation output must not expose legacy URL userinfo",
);

const currentPaths = projectPaths(movedRoot);
assert(currentPaths.identity.id === fixture.legacyId, "moved checkout must retain the legacy storage id");
const nextDeployment = JSON.parse(fs.readFileSync(fixture.storage.deployment, "utf8"));
const nextRegistry = JSON.parse(fs.readFileSync(fixture.registryPath, "utf8"));
const nextRecord = nextRegistry.projects[fixture.legacyId];
assert(
  JSON.stringify(nextDeployment.identity) === JSON.stringify(currentPaths.identity),
  "deployment identity must become the active canonical and redacted checkout identity",
);
assert(
  JSON.stringify({
    id: nextRecord.id,
    root: nextRecord.root,
    gitCommonDir: nextRecord.gitCommonDir,
    remote: nextRecord.remote,
  }) === JSON.stringify(currentPaths.identity),
  "registry identity must match the reconciled deployment exactly",
);
assert(
  JSON.stringify(withoutIdentity(nextDeployment))
    === JSON.stringify(withoutIdentity(fixture.deployment as Record<string, unknown>)),
  "reconciliation must preserve every non-identity deployment field",
);
assert(
  JSON.stringify(withoutRegistryIdentity(nextRecord))
    === JSON.stringify(withoutRegistryIdentity(
      fixture.registry.projects[fixture.legacyId] as Record<string, unknown>,
    )),
  "reconciliation must preserve every non-identity registry-record field",
);
assert(nextRegistry.revision === fixture.registry.revision, "reconciliation must not invent a registry revision");
assert(nextRegistry.unknownRegistry?.preserve === "registry", "reconciliation must preserve unknown registry fields");
assertSnapshot(preservedOpaqueFiles, movedBefore, "reconciliation must preserve opaque workflow and ownership state");
assert(checkSetupStamp(movedRoot).status === "current", "runtime setup gate must accept the reconciled deployment");
assert(gitStatus(movedRoot) === gitBefore, "successful reconciliation must not mutate the worktree");

const stableFiles = [...externalFiles, skillPaths.manifestPath];
const stableBefore = snapshot(stableFiles);
const repeated = await runHelperCli(
  ["install", "--clients", "codex", "--mode", "copy", "--json"],
  installDependencies,
);
assert(repeated.exitCode === 0 && repeated.envelope.layers.project.status === "preserved", "repeated moved-checkout install must succeed");
assertSnapshot(stableFiles, stableBefore, "repeated helper install must be a byte-for-byte no-op");

const collisionRuntime = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-identity-collision-"));
setRuntimeRoots(collisionRuntime);
const collisionRoot = makeGitProject("hy-helper-identity-collision-project-");
execFileSync("git", ["remote", "add", "origin", rawRemote], { cwd: collisionRoot });
const collisionFixture = seedLegacyState(collisionRoot, rawRemote);
const canonicalStorage = projectStoragePaths(collisionFixture.canonicalId);
writeJson(canonicalStorage.config, { collision: "canonical-state" });
const collisionFiles = [
  collisionFixture.storage.config,
  collisionFixture.storage.deployment,
  collisionFixture.registryPath,
  collisionFixture.storage.workflowState,
  collisionFixture.storage.scope,
  collisionFixture.storage.docsGraph,
  collisionFixture.ownershipPath,
  canonicalStorage.config,
];
const collisionBefore = snapshot(collisionFiles);
const collisionSkillPaths = skillPathsFor(collisionRuntime);
const collision = await runHelperCli(
  ["install", "--clients", "codex", "--mode", "copy", "--json"],
  {
    cwd: collisionRoot,
    bundleRoot,
    skillPaths: collisionSkillPaths,
    detectedTargets: [detectedCodex(collisionRuntime)],
    skillHooks: { createSymlink: () => { throw new Error("copy"); } },
  },
);
assert(
  collision.exitCode === 1 && collision.envelope.error?.code === "PROJECT_IDENTITY_CONFLICT",
  "simultaneous canonical and legacy state must fail closed",
);
assert(!fs.existsSync(collisionSkillPaths.manifestPath), "identity collision must fail before Skill installation");
assertSnapshot(collisionFiles, collisionBefore, "identity collision must preserve all external state");
assert(
  !collision.stdout.includes(secret) && !collision.stdout.includes(user),
  "identity collision output must not expose legacy URL userinfo",
);

type CoherenceMutation = (paths: ReturnType<typeof projectPaths>) => void;

async function assertCoherenceFailure(
  label: string,
  mutate: CoherenceMutation,
  expectedField: string,
): Promise<void> {
  const caseRuntime = fs.mkdtempSync(path.join(os.tmpdir(), `hy-helper-coherence-${label}-`));
  setRuntimeRoots(caseRuntime);
  const caseRoot = makeGitProject(`hy-helper-coherence-${label}-project-`);
  await registerHelperProject(caseRoot, ["codex"]);
  const casePaths = projectPaths(caseRoot);
  const caseSkillPaths = skillPathsFor(caseRuntime);
  mutate(casePaths);
  const files = [
    casePaths.config,
    casePaths.deployment,
    casePaths.registry,
    casePaths.workflowState,
    casePaths.scope,
  ];
  const before = snapshot(files);
  const dependencies = {
    cwd: caseRoot,
    bundleRoot,
    skillPaths: caseSkillPaths,
    detectedTargets: [detectedCodex(caseRuntime)],
    skillHooks: { createSymlink: () => { throw new Error("copy"); } },
  };

  const status = await runHelperCli(["status", "--json"], dependencies);
  const statusFields = status.envelope.error?.detail?.mismatchedFields as string[] | undefined;
  assert(
    status.exitCode === 1
      && status.envelope.error?.code === "HELPER_DEPLOYMENT_REGISTRY_MISMATCH"
      && statusFields?.includes(expectedField),
    `${label} status must fail closed with exact mismatch facts: ${status.stdout}`,
  );
  assert(status.envelope.layers.mcp.status === "not_run", `${label} status must not touch MCP state`);
  assertSnapshot(files, before, `${label} status must preserve all project registration bytes`);

  const install = await runHelperCli(
    ["install", "--clients", "codex", "--mode", "copy", "--json"],
    dependencies,
  );
  const installFields = install.envelope.error?.detail?.mismatchedFields as string[] | undefined;
  assert(
    install.exitCode === 1
      && install.envelope.error?.code === "HELPER_DEPLOYMENT_REGISTRY_MISMATCH"
      && installFields?.includes(expectedField),
    `${label} install must fail before mutation with exact mismatch facts: ${install.stdout}`,
  );
  assert(install.envelope.layers.skills.status === "not_run", `${label} install must not mutate Skills`);
  assert(install.envelope.layers.mcp.status === "not_run", `${label} install must not touch MCP state`);
  assert(!fs.existsSync(caseSkillPaths.manifestPath), `${label} install must not create Skill ownership`);
  assertSnapshot(files, before, `${label} install must preserve all project registration bytes`);
}

await assertCoherenceFailure("missing-registry", paths => {
  fs.rmSync(paths.registry, { force: true });
}, "registryRecord");

await assertCoherenceFailure("orphan-registry", paths => {
  fs.rmSync(paths.deployment, { force: true });
}, "deployment");

for (const field of ["mode", "clients", "updatedAt"] as const) {
  await assertCoherenceFailure(`drift-${field}`, paths => {
    const registry = JSON.parse(fs.readFileSync(paths.registry, "utf8"));
    const record = registry.projects[paths.identity.id];
    if (field === "mode") record.mode = "local";
    if (field === "clients") record.clients = [];
    if (field === "updatedAt") record.updatedAt = "2000-01-01T00:00:00.000Z";
    writeJson(paths.registry, registry);
  }, field);
}

console.log("helper-project-identity: read-only status, atomic move reconciliation, rollback, idempotence, collision, and credential redaction pass");
