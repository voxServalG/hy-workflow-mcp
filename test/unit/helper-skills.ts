import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  HELPER_SKILL_NAMES,
  HelperSkillError,
  detectGlobalSkillTargets,
  getHelperSkillStatus,
  hashDirectory,
  installHelperSkills,
  readHelperSkillBundle,
  removeHelperSkills,
  updateHelperSkills,
  type HelperSkillPaths,
} from "../../src/helper/skills.js";
import { resolvedDirectory } from "../../src/helper/skill-fs.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    if (!(error instanceof HelperSkillError) || error.code !== code) throw error;
  }
}

function pathsFor(root: string): HelperSkillPaths {
  const dataRoot = path.join(root, "data", "hy-workflow");
  const stateRoot = path.join(root, "state", "hy-workflow");
  return {
    dataRoot,
    stateRoot,
    ssotRoot: path.join(dataRoot, "skills"),
    manifestPath: path.join(stateRoot, "skill-ownership.json"),
    lockPath: path.join(stateRoot, "skill-projector.lock"),
  };
}

const repositoryRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const repositoryBundle = path.join(repositoryRoot, "skills");
const bundle = readHelperSkillBundle(repositoryBundle);
assert(bundle.skills.length === 12, "the package bundle must contain the twelve stage Skills");
assert(bundle.skills.map(skill => skill.name).join(",") === HELPER_SKILL_NAMES.join(","), "bundle order must be deterministic");

for (const skill of bundle.skills) {
  const text = fs.readFileSync(path.join(skill.sourcePath, "SKILL.md"), "utf8");
  if (skill.name === "hy-status") {
    assert(text.includes("Shared CLI control contract") && text.includes("sole authority"), "hy-status must own the shared CLI authority contract");
    assert(text.includes("route.action.argv"), "hy-status must define exact CLI argv routing");
    assert(text.includes("route.allowed") && text.includes("route.blocked"), "hy-status must define CLI routing boundaries");
    assert(text.includes("private state files"), "hy-status must forbid private-state access");
  } else {
    assert(text.includes("[`../hy-status/SKILL.md`](../hy-status/SKILL.md)"), `${skill.name} must load the shared hy-status prerequisite`);
    assert(!text.includes("## CLI control contract") && !text.includes("## Shared CLI control contract"), `${skill.name} must not duplicate the shared CLI control contract`);
  }
  for (const forbidden of ["allowedTools", "nextAction", "display", "summary", "hint", "`hy_status`"]) {
    assert(!text.includes(forbidden), `${skill.name} must not depend on removed MCP field or tool ${forbidden}`);
  }
}
const initText = fs.readFileSync(path.join(repositoryBundle, "hy-init", "SKILL.md"), "utf8");
for (const required of ["progressive local documentation", "pull-request evidence", "recent local commits", "Identify ecosystems", "Identify the test platform", "Do not access Feishu, Lark"]) {
  assert(initText.includes(required), `hy-init must include local orientation cognition: ${required}`);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-helper-skills-"));
if (process.platform !== "win32") {
  const realParent = path.join(root, "resolved-real");
  const aliasParent = path.join(root, "resolved-alias");
  const missingTarget = path.join(aliasParent, "missing", "skills");
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, aliasParent, "dir");
  const beforeCreation = resolvedDirectory(missingTarget);
  fs.mkdirSync(path.join(realParent, "missing", "skills"), { recursive: true });
  const afterCreation = resolvedDirectory(missingTarget);
  assert(beforeCreation === afterCreation, "resolved target identity must remain stable when an aliased parent gains missing descendants");
  assert(afterCreation === path.join(fs.realpathSync.native(realParent), "missing", "skills"), "resolved target identity must use the canonical nearest existing ancestor");
}

const bundleRoot = path.join(root, "bundle");
fs.cpSync(repositoryBundle, bundleRoot, { recursive: true });
const paths = pathsFor(root);
const codexRoot = path.join(root, ".codex");
const claudeRoot = path.join(root, ".claude");
const openCodeRoot = path.join(root, ".config", "opencode");
for (const directory of [codexRoot, claudeRoot, openCodeRoot]) fs.mkdirSync(directory, { recursive: true });

const detected = detectGlobalSkillTargets({
  home: root,
  env: { PATH: "", XDG_CONFIG_HOME: path.join(root, ".config") },
  platform: process.platform,
});
assert(detected.every(target => target.detected), "existing Codex, Claude, and OpenCode config roots must be detected");
assert(detected.find(target => target.agent === "codex")?.skillsDir === path.join(codexRoot, "skills"), "Codex global Skill path must be exact");
assert(detected.find(target => target.agent === "claude")?.skillsDir === path.join(claudeRoot, "skills"), "Claude global Skill path must be exact");
assert(detected.find(target => target.agent === "opencode")?.skillsDir === path.join(openCodeRoot, "skills"), "OpenCode global Skill path must be exact");

const targets = detected.map(({ agent, skillsDir }) => ({ agent, skillsDir }));
const invalidFrontmatterBundle = path.join(root, "invalid-frontmatter-bundle");
fs.cpSync(repositoryBundle, invalidFrontmatterBundle, { recursive: true });
const invalidFrontmatterPath = path.join(invalidFrontmatterBundle, "hy-status", "SKILL.md");
fs.writeFileSync(
  invalidFrontmatterPath,
  fs.readFileSync(invalidFrontmatterPath, "utf8").replace(/^---\r?\n/, "---\nversion: 1\n"),
);
expectCode(() => readHelperSkillBundle(invalidFrontmatterBundle), "HELPER_SKILL_BUNDLE_INVALID");
const invalidInstallRoot = path.join(root, "invalid-frontmatter-install");
const invalidInstallPaths = pathsFor(invalidInstallRoot);
const invalidInstallSkillsDir = path.join(invalidInstallRoot, "agent", "skills");
expectCode(
  () => installHelperSkills({
    bundleRoot: invalidFrontmatterBundle,
    paths: invalidInstallPaths,
    targets: [{ agent: "codex", skillsDir: invalidInstallSkillsDir }],
    mode: "copy",
  }),
  "HELPER_SKILL_BUNDLE_INVALID",
);
assert(!fs.existsSync(invalidInstallPaths.manifestPath), "invalid frontmatter must fail before writing an ownership manifest");
assert(!fs.existsSync(invalidInstallPaths.ssotRoot), "invalid frontmatter must fail before writing canonical Skills");
assert(!fs.existsSync(path.join(invalidInstallSkillsDir, "hy-status")), "invalid frontmatter must fail before projecting a Skill");

fs.mkdirSync(paths.lockPath, { recursive: true });
try {
  installHelperSkills({
    bundleRoot,
    packageVersion: "1.0.0-test",
    paths,
    targets,
    mode: "copy",
  });
  throw new Error("an owned projector lock must stop a concurrent install");
} catch (error) {
  assert(error instanceof HelperSkillError && error.code === "HELPER_SKILL_BUSY", "concurrent install must return HELPER_SKILL_BUSY");
  assert(error.retryable === true, "HELPER_SKILL_BUSY must be explicitly retryable");
}
const staleLockTime = new Date(Date.now() - 61_000);
fs.utimesSync(paths.lockPath, staleLockTime, staleLockTime);
const copyFallbackHooks = { createSymlink: () => { throw new Error("simulated unavailable symlink"); } };
const installed = installHelperSkills({
  bundleRoot,
  packageVersion: "1.0.0-test",
  paths,
  targets,
  mode: "auto",
  hooks: copyFallbackHooks,
});
assert(!fs.existsSync(paths.lockPath), "a stale ownerless projector lock must be reclaimed and released");
assert(installed.action === "installed" && installed.manifest?.skills.length === 12, "install must own all twelve Skills");
assert(installed.manifest.targets.length === 3, "manifest must persist the exact target set");
assert(installed.manifest.skills.every(skill => skill.projections.every(projection => projection.mode === "copy")), "auto mode must record atomic copy fallback exactly");
const stateBeforeInvalidUpdate = JSON.stringify({
  manifest: fs.readFileSync(paths.manifestPath, "utf8"),
  canonical: hashDirectory(paths.ssotRoot),
  targets: installed.manifest.targets.map(target => [target.agent, hashDirectory(target.skillsDir)]),
});
expectCode(
  () => updateHelperSkills({ bundleRoot: invalidFrontmatterBundle, packageVersion: "1.0.1-invalid", paths }),
  "HELPER_SKILL_BUNDLE_INVALID",
);
assert(JSON.stringify({
  manifest: fs.readFileSync(paths.manifestPath, "utf8"),
  canonical: hashDirectory(paths.ssotRoot),
  targets: installed.manifest.targets.map(target => [target.agent, hashDirectory(target.skillsDir)]),
}) === stateBeforeInvalidUpdate, "invalid frontmatter must fail before updating any owned resource");

const versionDrift = getHelperSkillStatus({ bundleRoot, packageVersion: "1.0.1-test", paths });
assert(versionDrift.state === "drifted", "a running CLI version mismatch must mark installed Skills as drifted");
assert(versionDrift.findings.some(finding => finding.code === "package_version_outdated"), "version drift must have a stable finding code");
assert(getHelperSkillStatus({ bundleRoot, packageVersion: "1.0.0-test", paths }).state === "healthy", "fresh projections must be healthy for the installing package version");
const defaultBundleStatus = getHelperSkillStatus({ packageVersion: "1.0.0-test", paths });
assert(defaultBundleStatus.state === "healthy", "production status must compare against the running package bundle by default");
assert(defaultBundleStatus.bundleHash === bundle.hash, "production status must expose the running package bundle hash without dependency injection");

const manifestBeforeNoop = fs.readFileSync(paths.manifestPath, "utf8");
const unchanged = updateHelperSkills({ bundleRoot, packageVersion: "1.0.0-test", paths });
assert(unchanged.action === "unchanged", "same version, hash, and targets must be idempotent");
assert(fs.readFileSync(paths.manifestPath, "utf8") === manifestBeforeNoop, "idempotent update must not rewrite ownership state");

const planCanonical = path.join(paths.ssotRoot, "hy-plan");
const planProjection = path.join(codexRoot, "skills", "hy-plan");
fs.rmSync(planCanonical, { recursive: true });
const restoredCanonical = updateHelperSkills({ bundleRoot, packageVersion: "1.0.1-test", paths, hooks: copyFallbackHooks });
const restoredPlan = restoredCanonical.manifest?.skills.find(skill => skill.name === "hy-plan");
assert(restoredPlan?.intentionalDeletion === false, "a missing hidden canonical Skill is corruption, not user deletion intent");
assert(fs.existsSync(planCanonical) && fs.existsSync(planProjection), "update must rebuild a missing canonical Skill without deleting healthy projections");

fs.rmSync(planProjection, { recursive: true });
const preserved = updateHelperSkills({ bundleRoot, packageVersion: "1.0.1-test", paths, hooks: copyFallbackHooks });
const preservedProjection = preserved.manifest?.skills.find(skill => skill.name === "hy-plan")?.projections.find(projection => projection.agent === "codex");
assert(preservedProjection?.intentionalDeletion, "update must preserve a user-deleted Agent projection");
assert(fs.existsSync(planCanonical) && !fs.existsSync(planProjection), "projection deletion must not remove the hidden canonical copy or other Agent projections");
assert(getHelperSkillStatus({ bundleRoot, packageVersion: "1.0.1-test", paths }).state === "healthy", "a recorded projection deletion must be healthy rather than permanent drift");

const repaired = updateHelperSkills({ bundleRoot, packageVersion: "1.0.1-test", paths, repair: true, hooks: copyFallbackHooks });
assert(repaired.manifest?.skills.find(skill => skill.name === "hy-plan")?.projections.find(projection => projection.agent === "codex")?.intentionalDeletion === false, "explicit repair must clear projection deletion intent");
assert(fs.existsSync(planCanonical) && fs.existsSync(planProjection), "repair must restore the deleted projection");

const statusProjection = path.join(codexRoot, "skills", "hy-status");
fs.appendFileSync(path.join(statusProjection, "SKILL.md"), "\nexternal edit\n");
expectCode(
  () => updateHelperSkills({ bundleRoot, packageVersion: "1.0.2-test", paths }),
  "HELPER_SKILL_OWNERSHIP_CONFLICT",
);
assert(fs.readFileSync(path.join(statusProjection, "SKILL.md"), "utf8").includes("external edit"), "hash conflict must preserve external projection edits");
fs.rmSync(statusProjection, { recursive: true });
fs.cpSync(path.join(paths.ssotRoot, "hy-status"), statusProjection, { recursive: true });

fs.appendFileSync(path.join(bundleRoot, "hy-status", "SKILL.md"), "\npackage update\n");
const manifestBeforeRollback = fs.readFileSync(paths.manifestPath, "utf8");
const canonicalHashBeforeRollback = hashDirectory(path.join(paths.ssotRoot, "hy-status"));
try {
  updateHelperSkills({
    bundleRoot,
    packageVersion: "1.0.2-test",
    paths,
    hooks: {
      ...copyFallbackHooks,
      beforeManifestWrite: () => { throw new Error("simulated manifest failure"); },
    },
  });
  throw new Error("expected simulated manifest failure");
} catch (error: any) {
  assert(error?.message === "simulated manifest failure", "rollback must surface the initiating failure");
}
assert(fs.readFileSync(paths.manifestPath, "utf8") === manifestBeforeRollback, "failed update must atomically restore the ownership manifest");
assert(hashDirectory(path.join(paths.ssotRoot, "hy-status")) === canonicalHashBeforeRollback, "failed update must roll back canonical content");

const updated = updateHelperSkills({ bundleRoot, packageVersion: "1.0.2-test", paths, hooks: copyFallbackHooks });
assert(updated.action === "updated", "changed package bundle must update managed Skills");
assert(fs.readFileSync(path.join(paths.ssotRoot, "hy-status", "SKILL.md"), "utf8").includes("package update"), "update must publish new package content");
const crashBundle = path.join(root, "crash-bundle");
fs.cpSync(bundleRoot, crashBundle, { recursive: true });
fs.appendFileSync(path.join(crashBundle, "hy-status", "SKILL.md"), "\nprocess crash update\n");
const crashFingerprint = (): string => JSON.stringify({
  manifest: fs.readFileSync(paths.manifestPath, "utf8"),
  canonical: hashDirectory(paths.ssotRoot),
  targets: installed.manifest!.targets.map(targetRecord => [
    targetRecord.agent,
    hashDirectory(targetRecord.skillsDir),
  ]),
});
const helperModuleUrl = new URL("../../src/helper/skills.ts", import.meta.url).href;
const crashScript = `
  const input = JSON.parse(process.argv[1]);
  const { updateHelperSkills } = await import(input.moduleUrl);
  updateHelperSkills({
    bundleRoot: input.bundleRoot,
    packageVersion: "1.0.3-crash",
    paths: input.paths,
    hooks: {
      afterMutation(_destination, index) {
        if (index === input.index) process.kill(process.pid, "SIGKILL");
      },
    },
  });
  throw new Error("SIGKILL injection was not reached");
`;
for (const index of [1, 8]) {
  const beforeCrash = crashFingerprint();
  const child = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    crashScript,
    JSON.stringify({ moduleUrl: helperModuleUrl, bundleRoot: crashBundle, paths, index }),
  ], {
    cwd: repositoryRoot,
    env: process.env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert(child.signal === "SIGKILL", `mutation ${index} child must die by SIGKILL: ${child.stderr}`);
  const recoveredStatus = getHelperSkillStatus({ bundleRoot, packageVersion: "1.0.2-test", paths });
  assert(recoveredStatus.state === "healthy", `status must recover stale journal after mutation ${index}`);
  assert(crashFingerprint() === beforeCrash, `mutation ${index} recovery must restore the exact pre-crash state`);
  assert(!fs.existsSync(paths.lockPath), `mutation ${index} recovery must release the stale lock`);
  assert(!fs.existsSync(path.join(paths.stateRoot, "skill-projector-journal.json")), `mutation ${index} recovery must remove the journal`);
}


const unrelated = path.join(codexRoot, "skills", "user-owned-skill");
fs.mkdirSync(unrelated);
fs.writeFileSync(path.join(unrelated, "SKILL.md"), "user owned\n");
fs.appendFileSync(path.join(paths.ssotRoot, "hy-edit", "SKILL.md"), "\nexternal canonical edit\n");
expectCode(() => removeHelperSkills({ paths }), "HELPER_SKILL_OWNERSHIP_CONFLICT");
assert(fs.existsSync(paths.manifestPath), "uninstall conflict must preserve the ownership manifest");
fs.rmSync(path.join(paths.ssotRoot, "hy-edit"), { recursive: true });
fs.cpSync(path.join(bundleRoot, "hy-edit"), path.join(paths.ssotRoot, "hy-edit"), { recursive: true });

const removed = removeHelperSkills({ paths });
assert(removed.action === "removed", "clean uninstall must remove all helper-owned resources");
assert(!fs.existsSync(paths.manifestPath) && !fs.existsSync(paths.ssotRoot), "uninstall must remove manifest and canonical SSOT");
assert(fs.existsSync(unrelated), "uninstall must preserve unrelated Agent Skills");
assert(removeHelperSkills({ paths }).action === "unchanged", "repeated uninstall must be idempotent");
const tamperRoot = path.join(root, "manifest-tamper");
const tamperPaths = pathsFor(tamperRoot);
const tamperSkillsDir = path.join(tamperRoot, "agent", "skills");
installHelperSkills({
  bundleRoot,
  packageVersion: "1.0.2-test",
  paths: tamperPaths,
  targets: [{ agent: "codex", skillsDir: tamperSkillsDir }],
  mode: "copy",
});
const tamperManifestBytes = fs.readFileSync(tamperPaths.manifestPath, "utf8");
const victimTarget = path.join(tamperRoot, "victim-target");
fs.mkdirSync(victimTarget, { recursive: true });
const victimSentinel = path.join(victimTarget, "keep.txt");
fs.writeFileSync(victimSentinel, "not helper owned\n");

const emptySkillsManifest = JSON.parse(tamperManifestBytes) as any;
emptySkillsManifest.skills = [];
fs.writeFileSync(tamperPaths.manifestPath, JSON.stringify(emptySkillsManifest));
expectCode(() => getHelperSkillStatus({ bundleRoot, paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
expectCode(() => removeHelperSkills({ paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
assert(fs.existsSync(path.join(tamperSkillsDir, "hy-init")), "an empty skill list must not release or mutate managed projections");
assert(fs.existsSync(tamperPaths.ssotRoot) && fs.existsSync(tamperPaths.manifestPath), "an empty skill list must preserve manifest and canonical SSOT");

const forgedSkillHashManifest = JSON.parse(tamperManifestBytes) as any;
forgedSkillHashManifest.skills[0].sourceHash = "0".repeat(64);
fs.writeFileSync(tamperPaths.manifestPath, JSON.stringify(forgedSkillHashManifest));
expectCode(() => getHelperSkillStatus({ bundleRoot, paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
assert(fs.existsSync(path.join(tamperSkillsDir, "hy-init")), "an inconsistent Skill hash must preserve managed projections");

const forgedProjectionHashManifest = JSON.parse(tamperManifestBytes) as any;
forgedProjectionHashManifest.skills[0].projections[0].contentHash = "0".repeat(64);
fs.writeFileSync(tamperPaths.manifestPath, JSON.stringify(forgedProjectionHashManifest));
expectCode(() => removeHelperSkills({ paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
assert(fs.existsSync(tamperPaths.ssotRoot) && fs.existsSync(tamperPaths.manifestPath), "an inconsistent projection hash must fail before owned mutations");

const forgedTargetManifest = JSON.parse(tamperManifestBytes) as any;
forgedTargetManifest.targets[0].skillsDir = victimTarget;
forgedTargetManifest.targets[0].resolvedSkillsDir = victimTarget;
for (const skill of forgedTargetManifest.skills) {
  skill.projections[0].path = path.join(victimTarget, skill.name);
}
fs.writeFileSync(tamperPaths.manifestPath, JSON.stringify(forgedTargetManifest));
expectCode(() => removeHelperSkills({ paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
assert(fs.readFileSync(victimSentinel, "utf8") === "not helper owned\n", "forged target manifest must not delete or alter a victim directory");
assert(fs.existsSync(tamperPaths.ssotRoot) && fs.existsSync(tamperPaths.manifestPath), "invalid target manifest must fail before owned mutations");

const resolvedDriftManifest = JSON.parse(tamperManifestBytes) as any;
resolvedDriftManifest.targets[0].resolvedSkillsDir = `${resolvedDriftManifest.targets[0].resolvedSkillsDir}-forged`;
fs.writeFileSync(tamperPaths.manifestPath, JSON.stringify(resolvedDriftManifest));
expectCode(() => getHelperSkillStatus({ bundleRoot, paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
expectCode(() => removeHelperSkills({ paths: tamperPaths }), "HELPER_SKILL_MANIFEST_INVALID");
assert(fs.existsSync(path.join(tamperSkillsDir, "hy-init")), "resolved target drift must preserve managed projections");
assert(fs.existsSync(tamperPaths.ssotRoot) && fs.existsSync(tamperPaths.manifestPath), "resolved target drift must preserve manifest and canonical SSOT");

fs.writeFileSync(tamperPaths.manifestPath, tamperManifestBytes);
assert(removeHelperSkills({ paths: tamperPaths }).action === "removed", "restored valid manifest should still uninstall cleanly");


expectCode(
  () => installHelperSkills({ bundleRoot, paths: pathsFor(path.join(root, "unsafe")), targets: [{ agent: "codex", skillsDir: path.join(root, "not-a-skill-dir") }] }),
  "HELPER_SKILL_PATH_UNSAFE",
);

function assertNoProjectionResidue(directory: string, label: string): void {
  const residue: string[] = [];
  const walk = (current: string): void => {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.name.includes(".hy-stage-")
          || entry.name.includes(".hy-backup-")
          || entry.name === "skill-projector-journal.json"
          || entry.name === "skill-projector-journal.json.write"
          || entry.name === "skill-projector.lock") {
        residue.push(file);
      }
      if (entry.isDirectory()) walk(file);
    }
  };
  walk(directory);
  assert(residue.length === 0, `${label} must leave no projection transaction artifacts: ${residue.join(", ")}`);
}

const installRaceRoot = path.join(root, "cas-install");
const installRacePaths = pathsFor(installRaceRoot);
const installRaceSkillsDir = path.join(installRaceRoot, "agent", "skills");
const installSentinel = path.join(installRacePaths.ssotRoot, "user-sentinel.txt");
expectCode(() => installHelperSkills({
  bundleRoot: repositoryBundle,
  packageVersion: "2.0.0-cas",
  paths: installRacePaths,
  targets: [{ agent: "codex", skillsDir: installRaceSkillsDir }],
  mode: "copy",
  hooks: {
    beforeMutation(destination, index) {
      if (index !== 1) return;
      assert(destination === path.resolve(installRacePaths.ssotRoot), "fresh-install race must target the canonical root first");
      fs.mkdirSync(destination);
      fs.writeFileSync(installSentinel, "user-created-during-install\n");
    },
  },
}), "HELPER_SKILL_OWNERSHIP_CONFLICT");
assert(fs.readFileSync(installSentinel, "utf8") === "user-created-during-install\n", "fresh-install CAS must preserve a concurrently created user resource byte-for-byte");
assert(!fs.existsSync(installRacePaths.manifestPath), "fresh-install CAS conflict must not create ownership state");
assert(!fs.existsSync(path.join(installRaceSkillsDir, "hy-init")), "fresh-install CAS conflict must not project any Skill");
assertNoProjectionResidue(installRaceRoot, "fresh-install CAS conflict");

const updateRaceRoot = path.join(root, "cas-update");
const updateRacePaths = pathsFor(updateRaceRoot);
const updateRaceSkillsDir = path.join(updateRaceRoot, "agent", "skills");
installHelperSkills({
  bundleRoot: repositoryBundle,
  packageVersion: "2.0.0-cas",
  paths: updateRacePaths,
  targets: [{ agent: "codex", skillsDir: updateRaceSkillsDir }],
  mode: "copy",
});
const updateRaceBundle = path.join(updateRaceRoot, "bundle-update");
fs.cpSync(repositoryBundle, updateRaceBundle, { recursive: true });
fs.appendFileSync(path.join(updateRaceBundle, "hy-status", "SKILL.md"), "\nCAS package update\n");
const updateManifestBefore = fs.readFileSync(updateRacePaths.manifestPath);
const updateProjectionBefore = hashDirectory(path.join(updateRaceSkillsDir, "hy-status"));
const updateSentinel = path.join(updateRacePaths.ssotRoot, "user-sentinel.txt");
expectCode(() => updateHelperSkills({
  bundleRoot: updateRaceBundle,
  packageVersion: "2.0.1-cas",
  paths: updateRacePaths,
  hooks: {
    beforeMutation(destination, index) {
      if (index !== 1) return;
      assert(destination === path.resolve(updateRacePaths.ssotRoot), "update race must target the canonical root first");
      fs.writeFileSync(updateSentinel, "user-created-during-update\n");
    },
  },
}), "HELPER_SKILL_OWNERSHIP_CONFLICT");
assert(fs.readFileSync(updateSentinel, "utf8") === "user-created-during-update\n", "update CAS must preserve a concurrent canonical edit byte-for-byte");
assert(fs.readFileSync(updateRacePaths.manifestPath).equals(updateManifestBefore), "update CAS conflict must preserve the ownership manifest");
assert(hashDirectory(path.join(updateRaceSkillsDir, "hy-status")) === updateProjectionBefore, "update CAS conflict must preserve projected Skill bytes");
assertNoProjectionResidue(updateRaceRoot, "update CAS conflict");

const removeRaceRoot = path.join(root, "cas-remove");
const removeRacePaths = pathsFor(removeRaceRoot);
const removeRaceSkillsDir = path.join(removeRaceRoot, "agent", "skills");
installHelperSkills({
  bundleRoot: repositoryBundle,
  packageVersion: "2.0.0-cas",
  paths: removeRacePaths,
  targets: [{ agent: "codex", skillsDir: removeRaceSkillsDir }],
  mode: "copy",
});
const removeManifestBefore = fs.readFileSync(removeRacePaths.manifestPath);
let removeSentinelPath = "";
let removeSentinelBytes = "";
expectCode(() => removeHelperSkills({
  paths: removeRacePaths,
  hooks: {
    beforeMutation(destination, index) {
      if (index !== 1) return;
      removeSentinelPath = path.join(destination, "SKILL.md");
      removeSentinelBytes = fs.readFileSync(removeSentinelPath, "utf8") + "\nuser-edit-during-remove\n";
      fs.writeFileSync(removeSentinelPath, removeSentinelBytes);
    },
  },
}), "HELPER_SKILL_OWNERSHIP_CONFLICT");
assert(removeSentinelPath !== "" && fs.readFileSync(removeSentinelPath, "utf8") === removeSentinelBytes, "remove CAS must preserve a concurrent projection edit byte-for-byte");
assert(fs.readFileSync(removeRacePaths.manifestPath).equals(removeManifestBefore), "remove CAS conflict must preserve the ownership manifest");
assert(fs.existsSync(removeRacePaths.ssotRoot), "remove CAS conflict must preserve the canonical Skill root");
assertNoProjectionResidue(removeRaceRoot, "remove CAS conflict");

console.log("helper-skills: bundle contract, detection, atomic projection, deletion preservation, conflicts, rollback, and uninstall pass");
