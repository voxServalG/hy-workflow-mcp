import * as fs from "node:fs";
import * as path from "node:path";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../package-meta.js";
import { defaultSkillBundleRoot, readHelperSkillBundle } from "./skill-bundle.js";
import { detectGlobalSkillTargets, helperSkillPaths } from "./skill-environment.js";
import {
  copyDirectory,
  ensureDirectory,
  hashDirectory,
  lstat,
  normalizeTargets,
  removeResource,
  stagePath,
  resourceFingerprint,
} from "./skill-fs.js";
import {
  inspectManifest,
  manifestFindings,
  projectionKey,
  readManifest,
} from "./skill-manifest.js";
import {
  prepareManifest,
  prepareProjection,
  runProjectedMutation,
  withLock,
} from "./skill-operation.js";
import {
  projectionJournalPath,
  projectionJournalWritePath,
} from "./skill-projection.js";
import {
  HelperSkillError,
  fail,
  type BundleOptions,
  type HelperSkillOperationResult,
  type HelperSkillOwnershipManifest,
  type HelperSkillOwnershipRecord,
  type HelperSkillPaths,
  type HelperSkillProjectionRecord,
  type HelperSkillStatus,
  type HelperSkillTarget,
  type InstallHelperSkillsOptions,
  type RemoveHelperSkillsOptions,
  type SkillBundleEntry,
  type UpdateHelperSkillsOptions,
} from "./skill-types.js";

function exactTargetsFromManifest(manifest: HelperSkillOwnershipManifest): HelperSkillTarget[] {
  return manifest.targets.map(target => ({ agent: target.agent, skillsDir: target.skillsDir }));
}

function assertRequestedTargetsMatch(manifest: HelperSkillOwnershipManifest, requested: HelperSkillTarget[] | undefined): void {
  if (!requested) return;
  const actual = exactTargetsFromManifest(manifest).sort((left, right) => left.agent.localeCompare(right.agent));
  const expected = requested.map(target => ({ agent: target.agent, skillsDir: path.resolve(target.skillsDir) })).sort((left, right) => left.agent.localeCompare(right.agent));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "An existing install owns a different exact Agent target set.", { actual, requested: expected });
  }
}
type StableManifestRead = {
  manifest: HelperSkillOwnershipManifest | null;
  fingerprint: string | null;
};

function readStableManifest(paths: HelperSkillPaths): StableManifestRead {
  const before = resourceFingerprint(paths.manifestPath);
  const manifest = readManifest(paths);
  const after = resourceFingerprint(paths.manifestPath);
  if (before !== after) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Skill ownership manifest changed while it was being inspected.", {
      path: paths.manifestPath,
      before,
      after,
    });
  }
  return { manifest, fingerprint: after };
}

function captureMutationFingerprints(
  paths: HelperSkillPaths,
  targets: HelperSkillOwnershipManifest["targets"],
  names: readonly string[],
): Map<string, string | null> {
  const fingerprints = new Map<string, string | null>();
  const capture = (destination: string): void => {
    const normalized = path.resolve(destination);
    fingerprints.set(normalized, resourceFingerprint(normalized));
  };
  capture(paths.ssotRoot);
  capture(paths.manifestPath);
  for (const name of names) {
    for (const target of targets) capture(path.join(target.skillsDir, name));
  }
  return fingerprints;
}

function sameFingerprints(
  left: ReadonlyMap<string, string | null>,
  right: ReadonlyMap<string, string | null>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [destination, fingerprint] of left) {
    if (!right.has(destination) || right.get(destination) !== fingerprint) return false;
  }
  return true;
}

function ownedMutationPreflight(
  manifest: HelperSkillOwnershipManifest,
  paths: HelperSkillPaths,
  names: readonly string[],
  expectedManifestFingerprint: string,
): {
  inspected: ReturnType<typeof inspectManifest>;
  fingerprints: Map<string, string | null>;
} {
  if (resourceFingerprint(paths.manifestPath) !== expectedManifestFingerprint) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Skill ownership manifest changed after it was read.", {
      path: paths.manifestPath,
    });
  }
  inspectManifest(manifest, paths);
  const first = captureMutationFingerprints(paths, manifest.targets, names);
  const inspected = inspectManifest(manifest, paths);
  const second = captureMutationFingerprints(paths, manifest.targets, names);
  if (!sameFingerprints(first, second)
      || second.get(path.resolve(paths.manifestPath)) !== expectedManifestFingerprint) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Managed Skill resources changed during ownership preflight.");
  }
  return { inspected, fingerprints: second };
}

function freshInstallPreflight(
  paths: HelperSkillPaths,
  targets: HelperSkillOwnershipManifest["targets"],
  names: readonly string[],
): Map<string, string | null> {
  const rootBefore = resourceFingerprint(paths.ssotRoot);
  const rootStat = lstat(paths.ssotRoot);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.readdirSync(paths.ssotRoot).length > 0)) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Canonical Skill root exists without ownership: ${paths.ssotRoot}`);
  }
  const rootAfter = resourceFingerprint(paths.ssotRoot);
  if (rootBefore !== rootAfter) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Canonical Skill root changed during install preflight.");
  }
  if (resourceFingerprint(paths.manifestPath) !== null) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Skill ownership manifest appeared during install preflight.");
  }
  const fingerprints = new Map<string, string | null>([
    [path.resolve(paths.ssotRoot), rootAfter],
    [path.resolve(paths.manifestPath), null],
  ]);
  for (const name of names) {
    for (const target of targets) {
      const destination = path.resolve(path.join(target.skillsDir, name));
      if (resourceFingerprint(destination) !== null) {
        fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Skill destination exists without helper ownership: ${destination}`);
      }
      fingerprints.set(destination, null);
    }
  }
  return fingerprints;
}


function installCore(options: InstallHelperSkillsOptions, paths: HelperSkillPaths): HelperSkillOperationResult {
  const existingRead = readStableManifest(paths);
  const existing = existingRead.manifest;
  if (existing) {
    assertRequestedTargetsMatch(existing, options.targets);
    if (options.mode && existing.targets.some(target => target.preference !== options.mode)) {
      fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "An existing install owns a different projection preference.");
    }
    return updateCore(options, paths, false);
  }

  const bundle = readHelperSkillBundle(options.bundleRoot);
  const targets = normalizeTargets(
    options.targets ?? detectGlobalSkillTargets(options).filter(target => target.detected).map(({ agent, skillsDir }) => ({ agent, skillsDir })),
    options.mode ?? "auto",
    paths.ssotRoot,
  );
  const rootStat = lstat(paths.ssotRoot);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.readdirSync(paths.ssotRoot).length > 0)) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Canonical Skill root exists without ownership: ${paths.ssotRoot}`);
  }
  for (const skill of bundle.skills) {
    for (const target of targets) {
      const destination = path.join(target.skillsDir, skill.name);
      if (lstat(destination)) fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Skill destination exists without helper ownership: ${destination}`);
    }
  }

  const preflight = freshInstallPreflight(paths, targets, bundle.skills.map(skill => skill.name));
  return runProjectedMutation(paths, targets, options.hooks, preflight, (transaction, created) => {
    ensureDirectory(path.dirname(paths.ssotRoot), created);
    const stagedRoot = stagePath(paths.ssotRoot);
    transaction.trackTemporary(stagedRoot);
    fs.mkdirSync(stagedRoot);
    try {
      for (const skill of bundle.skills) copyDirectory(skill.sourcePath, path.join(stagedRoot, skill.name));
      transaction.swap(stagedRoot, paths.ssotRoot);
    } finally { removeResource(stagedRoot); }

    const records: HelperSkillOwnershipRecord[] = [];
    for (const skill of bundle.skills) {
      const canonicalPath = path.join(paths.ssotRoot, skill.name);
      const projections: HelperSkillProjectionRecord[] = [];
      for (const target of targets) {
        const destination = path.join(target.skillsDir, skill.name);
        const staged = prepareProjection(canonicalPath, destination, target.preference, transaction, created, options.hooks);
        try { transaction.swap(staged.prepared, destination); } finally { removeResource(staged.prepared); }
        projections.push({ agent: target.agent, path: destination, mode: staged.mode, contentHash: skill.hash, intentionalDeletion: false });
      }
      records.push({
        name: skill.name,
        canonicalPath,
        sourceHash: skill.hash,
        contentHash: skill.hash,
        intentionalDeletion: false,
        retired: false,
        projections: projections.sort((left, right) => left.agent.localeCompare(right.agent)),
      });
    }
    const now = new Date().toISOString();
    const manifest: HelperSkillOwnershipManifest = {
      schemaVersion: "1",
      package: { name: options.packageName ?? PACKAGE_NAME, version: options.packageVersion ?? PACKAGE_VERSION, bundleHash: bundle.hash },
      canonicalRoot: paths.ssotRoot,
      targets,
      skills: records.sort((left, right) => left.name.localeCompare(right.name)),
      installedAt: now,
      updatedAt: now,
    };
    options.hooks?.beforeManifestWrite?.();
    const preparedManifest = prepareManifest(manifest, paths, transaction, created);
    try { transaction.swap(preparedManifest, paths.manifestPath); } finally { removeResource(preparedManifest); }
    return { action: "installed", manifest, changes: [paths.ssotRoot, ...records.flatMap(skill => skill.projections.map(projection => projection.path)), paths.manifestPath] };
  });
}

function updateCore(options: BundleOptions, paths: HelperSkillPaths, repair: boolean): HelperSkillOperationResult {
  const manifestRead = readStableManifest(paths);
  const manifest = manifestRead.manifest;
  if (!manifest || manifestRead.fingerprint === null) fail("HELPER_SKILL_NOT_INSTALLED", "The helper Skill bundle is not installed.");
  const bundle = readHelperSkillBundle(options.bundleRoot);
  const findings = manifestFindings(manifest, paths);
  const packageName = options.packageName ?? PACKAGE_NAME;
  const packageVersion = options.packageVersion ?? PACKAGE_VERSION;
  if (!repair && !findings.length && manifest.package.name === packageName
    && manifest.package.version === packageVersion && manifest.package.bundleHash === bundle.hash) {
    return { action: "unchanged", manifest, changes: [] };
  }

  const bundleByName = new Map(bundle.skills.map(skill => [skill.name, skill]));
  const previousByName = new Map(manifest.skills.map(skill => [skill.name, skill]));
  const names = [...new Set([...bundle.skills.map(skill => skill.name), ...manifest.skills.map(skill => skill.name)])].sort();

  const { inspected, fingerprints } = ownedMutationPreflight(manifest, paths, names, manifestRead.fingerprint);
  return runProjectedMutation(paths, manifest.targets, options.hooks, fingerprints, (transaction, created) => {
    ensureDirectory(path.dirname(paths.ssotRoot), created);
    const stagedRoot = stagePath(paths.ssotRoot);
    transaction.trackTemporary(stagedRoot);
    fs.mkdirSync(stagedRoot);
    const desired: Array<{
      name: string;
      bundle: SkillBundleEntry | undefined;
      previous: HelperSkillOwnershipRecord | undefined;
      canonicalDeleted: boolean;
      retired: boolean;
      sourceHash: string;
      contentHash: string;
    }> = [];
    try {
      for (const name of names) {
        const bundleSkill = bundleByName.get(name as SkillBundleEntry["name"]);
        const previous = previousByName.get(name);
        const missing = previous ? inspected.canonical.get(name) === "missing" : false;
        if (missing && !bundleSkill && (repair || !previous?.intentionalDeletion)) {
          fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Missing retired canonical Skill cannot be rebuilt from the package: ${name}`);
        }
        const canonicalDeleted = Boolean(previous && !repair && previous.intentionalDeletion);
        const retired = !bundleSkill;
        const sourceHash = bundleSkill?.hash ?? previous!.sourceHash;
        const contentHash = bundleSkill?.hash ?? previous!.contentHash;
        desired.push({ name, bundle: bundleSkill, previous, canonicalDeleted, retired, sourceHash, contentHash });
        if (canonicalDeleted) continue;
        const destination = path.join(stagedRoot, name);
        if (bundleSkill) copyDirectory(bundleSkill.sourcePath, destination);
        else copyDirectory(previous!.canonicalPath, destination);
        const actual = hashDirectory(destination);
        if (actual !== contentHash) fail("HELPER_SKILL_BUNDLE_INVALID", `Staged Skill hash mismatch: ${name}`);
      }
      transaction.swap(stagedRoot, paths.ssotRoot);
    } finally { removeResource(stagedRoot); }

    const records: HelperSkillOwnershipRecord[] = [];
    const changes: string[] = [paths.ssotRoot];
    for (const item of desired) {
      const canonicalPath = path.join(paths.ssotRoot, item.name);
      const projections: HelperSkillProjectionRecord[] = [];
      for (const target of manifest.targets) {
        const destination = path.join(target.skillsDir, item.name);
        const previousProjection = item.previous?.projections.find(projection => projection.agent === target.agent);
        const projectionMissing = previousProjection
          ? inspected.projections.get(projectionKey(item.name, target.agent)) === "missing"
          : false;
        const projectionDeleted = item.canonicalDeleted || Boolean(previousProjection && !repair && (previousProjection.intentionalDeletion || projectionMissing));
        if (projectionDeleted) {
          transaction.remove(destination);
          if (fingerprints.get(path.resolve(destination)) !== null) changes.push(destination);
          projections.push({
            agent: target.agent,
            path: destination,
            mode: previousProjection?.mode ?? (target.preference === "copy" ? "copy" : "symlink"),
            contentHash: item.contentHash,
            intentionalDeletion: true,
          });
          continue;
        }
        const staged = prepareProjection(canonicalPath, destination, target.preference, transaction, created, options.hooks);
        try { transaction.swap(staged.prepared, destination); } finally { removeResource(staged.prepared); }
        changes.push(destination);
        projections.push({ agent: target.agent, path: destination, mode: staged.mode, contentHash: item.contentHash, intentionalDeletion: false });
      }
      records.push({
        name: item.name,
        canonicalPath,
        sourceHash: item.sourceHash,
        contentHash: item.contentHash,
        intentionalDeletion: item.canonicalDeleted,
        retired: item.retired,
        projections: projections.sort((left, right) => left.agent.localeCompare(right.agent)),
      });
    }

    const nextManifest: HelperSkillOwnershipManifest = {
      schemaVersion: "1",
      package: { name: packageName, version: packageVersion, bundleHash: bundle.hash },
      canonicalRoot: paths.ssotRoot,
      targets: manifest.targets,
      skills: records.sort((left, right) => left.name.localeCompare(right.name)),
      installedAt: manifest.installedAt,
      updatedAt: new Date().toISOString(),
    };
    options.hooks?.beforeManifestWrite?.();
    const preparedManifest = prepareManifest(nextManifest, paths, transaction, created);
    try { transaction.swap(preparedManifest, paths.manifestPath); } finally { removeResource(preparedManifest); }
    changes.push(paths.manifestPath);
    return { action: "updated", manifest: nextManifest, changes };
  });
}

export function installHelperSkills(options: InstallHelperSkillsOptions = {}): HelperSkillOperationResult {
  const paths = options.paths ?? helperSkillPaths(options);
  return withLock(paths, () => installCore(options, paths));
}

export function updateHelperSkills(options: UpdateHelperSkillsOptions = {}): HelperSkillOperationResult {
  const paths = options.paths ?? helperSkillPaths(options);
  return withLock(paths, () => updateCore(options, paths, Boolean(options.repair)));
}

export function removeHelperSkills(options: RemoveHelperSkillsOptions = {}): HelperSkillOperationResult {
  const paths = options.paths ?? helperSkillPaths(options);
  return withLock(paths, () => {
    const manifestRead = readStableManifest(paths);
    const manifest = manifestRead.manifest;
    if (!manifest) return { action: "unchanged", manifest: null, changes: [] };
    if (manifestRead.fingerprint === null) fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Installed Skill manifest disappeared during removal preflight.");
    const names = manifest.skills.map(skill => skill.name);
    const { fingerprints } = ownedMutationPreflight(manifest, paths, names, manifestRead.fingerprint);
    return runProjectedMutation(paths, manifest.targets, options.hooks, fingerprints, transaction => {
      const changes: string[] = [];
      for (const skill of manifest.skills) {
        for (const projection of skill.projections) {
          transaction.remove(projection.path);
          if (fingerprints.get(path.resolve(projection.path)) !== null) changes.push(projection.path);
        }
      }
      transaction.remove(paths.ssotRoot);
      if (fingerprints.get(path.resolve(paths.ssotRoot)) !== null) changes.push(paths.ssotRoot);
      options.hooks?.beforeManifestWrite?.();
      transaction.remove(paths.manifestPath);
      changes.push(paths.manifestPath);
      return { action: "removed", manifest: null, changes };
    });
  });
}

export function getHelperSkillStatus(options: BundleOptions = {}): HelperSkillStatus {
  const paths = options.paths ?? helperSkillPaths(options);
  const journal = projectionJournalPath(paths);
  if (lstat(paths.lockPath) || lstat(journal) || lstat(projectionJournalWritePath(paths))) {
    try {
      withLock(paths, () => undefined);
    } catch (error) {
      if (error instanceof HelperSkillError && error.code === "HELPER_SKILL_BUSY") {
        return {
          state: "drifted",
          paths,
          manifest: null,
          findings: [{ code: "projection_operation_active", path: paths.lockPath, message: "A live Skill projection operation is active." }],
          bundleHash: null,
        };
      }
      throw error;
    }
  }
  const manifest = readManifest(paths);
  if (!manifest) {
    const unmanaged = Boolean(lstat(paths.ssotRoot));
    return { state: unmanaged ? "unmanaged" : "absent", paths, manifest: null, findings: unmanaged ? [{ code: "unowned_canonical_root", path: paths.ssotRoot, message: "Canonical root exists without an ownership manifest." }] : [], bundleHash: null };
  }
  const findings = manifestFindings(manifest, paths);
  const packageName = options.packageName ?? PACKAGE_NAME;
  const packageVersion = options.packageVersion ?? PACKAGE_VERSION;
  if (manifest.package.name !== packageName) {
    findings.push({ code: "package_name_mismatch", path: paths.manifestPath, message: "Installed Skill bundle belongs to a different package." });
  }
  if (manifest.package.version !== packageVersion) {
    findings.push({ code: "package_version_outdated", path: paths.manifestPath, message: "Installed Skill bundle version differs from the running CLI package." });
  }
  const bundle = readHelperSkillBundle(options.bundleRoot ?? defaultSkillBundleRoot());
  const bundleHash = bundle.hash;
  if (bundle.hash !== manifest.package.bundleHash) findings.push({ code: "bundle_outdated", path: bundle.root, message: "Installed Skill bundle differs from the package bundle." });
  return { state: findings.length ? "drifted" : "healthy", paths, manifest, findings, bundleHash };
}
