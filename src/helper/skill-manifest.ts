import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectionRuntime } from "./skill-projection.js";
import {
  assertNoOverlap,
  hashDirectory,
  lstat,
  normalizeTargets,
  removeResource,
  resolvedDirectory,
  publishPreparedNoReplace,
  resourceFingerprint,
} from "./skill-fs.js";
import {
  HELPER_SKILL_AGENTS,
  HELPER_SKILL_NAMES,
  LEGACY_HELPER_SKILL_NAMES,
  MANAGED_HELPER_SKILL_NAMES,
  HelperSkillError,
  fail,
  type HelperSkillAgent,
  type HelperSkillFinding,
  type HelperSkillOwnershipManifest,
  type HelperSkillPaths,
  type HelperSkillTargetRecord,
  type InspectedOwnership,
} from "./skill-types.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function safeSkillName(name: unknown): name is string {
  return typeof name === "string" && SAFE_NAME_PATTERN.test(name) && !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export const PROJECTION_RUNTIME: ProjectionRuntime = {
  skillNames: MANAGED_HELPER_SKILL_NAMES,
  agents: HELPER_SKILL_AGENTS,
  fail,
  isHelperSkillError: error => error instanceof HelperSkillError,
  lstat,
  normalizeTargets,
  removeResource,
  resourceFingerprint,
  publishPreparedNoReplace,
};

function validateManifest(value: unknown, expectedPaths: HelperSkillPaths): HelperSkillOwnershipManifest {
  const invalid = (reason: string): never => fail("HELPER_SKILL_MANIFEST_INVALID", `Invalid Skill ownership manifest: ${reason}`);
  if (!isObject(value)) invalid("root object");
  const root = value as Record<string, unknown>;
  if ((root.schemaVersion !== "1" && root.schemaVersion !== "2") || !isObject(root.package)) invalid("root fields");
  const expectedCatalog = root.schemaVersion === "1" ? LEGACY_HELPER_SKILL_NAMES : HELPER_SKILL_NAMES;
  const packageRecord = root.package as Record<string, unknown>;
  if (typeof packageRecord.name !== "string" || typeof packageRecord.version !== "string" || !HASH_PATTERN.test(String(packageRecord.bundleHash))) invalid("package fields");
  if (typeof root.canonicalRoot !== "string" || path.resolve(root.canonicalRoot) !== path.resolve(expectedPaths.ssotRoot)) invalid("canonical root");
  if (!Array.isArray(root.targets) || !Array.isArray(root.skills)) invalid("target or skill list");
  if (typeof root.installedAt !== "string" || !Number.isFinite(Date.parse(root.installedAt))
    || typeof root.updatedAt !== "string" || !Number.isFinite(Date.parse(root.updatedAt))) invalid("timestamps");

  const targets = root.targets as unknown[];
  const targetAgents = new Set<string>();
  const targetRecords: HelperSkillTargetRecord[] = [];
  for (const candidate of targets) {
    if (!isObject(candidate)) invalid("target object");
    const item = candidate as Record<string, unknown>;
    if (!HELPER_SKILL_AGENTS.includes(item.agent as HelperSkillAgent)
      || typeof item.skillsDir !== "string" || !path.isAbsolute(item.skillsDir)
      || typeof item.resolvedSkillsDir !== "string" || !path.isAbsolute(item.resolvedSkillsDir)
      || !["auto", "symlink", "copy"].includes(String(item.preference))
      || targetAgents.has(String(item.agent))) invalid("target record");
    targetAgents.add(String(item.agent));
    targetRecords.push(item as unknown as HelperSkillTargetRecord);
  }

  let normalizedTargets: HelperSkillTargetRecord[];
  try {
    normalizedTargets = normalizeTargets(
      targetRecords.map(({ agent, skillsDir }) => ({ agent, skillsDir })),
      "auto",
      expectedPaths.ssotRoot,
    );
  } catch (error) {
    if (error instanceof HelperSkillError
      && (error.code === "HELPER_SKILL_PATH_UNSAFE" || error.code === "HELPER_SKILL_NO_TARGETS")) {
      invalid("target path invariants");
    }
    throw error;
  }
  const targetsByAgent = new Map(normalizedTargets.map(target => [target.agent, target]));
  for (const target of targetRecords) {
    const normalized = targetsByAgent.get(target.agent);
    if (!normalized
      || target.skillsDir !== normalized.skillsDir
      || target.resolvedSkillsDir !== normalized.resolvedSkillsDir) {
      invalid("target path or resolution drift");
    }
  }

  const expectedSkillNames = new Set<string>(expectedCatalog);
  const skillNames = new Set<string>();
  const currentSkillHashes = new Map<string, string>();
  for (const candidate of root.skills as unknown[]) {
    if (!isObject(candidate)) invalid("skill object");
    const item = candidate as Record<string, unknown>;
    if (!safeSkillName(item.name) || skillNames.has(item.name)
      || typeof item.canonicalPath !== "string" || path.resolve(item.canonicalPath) !== path.join(expectedPaths.ssotRoot, item.name)
      || !HASH_PATTERN.test(String(item.sourceHash)) || !HASH_PATTERN.test(String(item.contentHash))
      || typeof item.intentionalDeletion !== "boolean" || typeof item.retired !== "boolean"
      || !Array.isArray(item.projections)) invalid("skill record");
    const skillName = item.name as string;
    skillNames.add(skillName);
    if (!expectedSkillNames.has(skillName) || item.retired !== false) invalid("skill catalog membership");
    if (item.sourceHash !== item.contentHash) invalid("skill hash relationship");
    currentSkillHashes.set(skillName, item.sourceHash as string);
    const projectionAgents = new Set<string>();
    for (const projectionCandidate of item.projections as unknown[]) {
      if (!isObject(projectionCandidate)) invalid("projection object");
      const projection = projectionCandidate as Record<string, unknown>;
      if (!HELPER_SKILL_AGENTS.includes(projection.agent as HelperSkillAgent)
        || projectionAgents.has(String(projection.agent)) || !targetAgents.has(String(projection.agent))
        || typeof projection.path !== "string" || !path.isAbsolute(projection.path)
        || !["symlink", "copy"].includes(String(projection.mode))
        || !HASH_PATTERN.test(String(projection.contentHash))
        || typeof projection.intentionalDeletion !== "boolean") invalid("projection record");
      const target = targetsByAgent.get(projection.agent as HelperSkillAgent);
      if (!target || path.resolve(projection.path as string) !== path.join(target.skillsDir, skillName)) {
        invalid("projection path");
      }
      if (projection.contentHash !== item.contentHash) invalid("projection hash relationship");
      projectionAgents.add(String(projection.agent));
    }
    if (projectionAgents.size !== targetAgents.size) invalid("incomplete projections");
  }
  if (currentSkillHashes.size !== expectedCatalog.length) invalid("incomplete current skill catalog");
  const bundleHash = createHash("sha256");
  for (const name of expectedCatalog) {
    const sourceHash = currentSkillHashes.get(name);
    if (!sourceHash) invalid("incomplete current skill catalog");
    bundleHash.update(name);
    bundleHash.update("\0");
    bundleHash.update(sourceHash!);
    bundleHash.update("\0");
  }
  if (bundleHash.digest("hex") !== packageRecord.bundleHash) invalid("package bundle hash relationship");
  return root as unknown as HelperSkillOwnershipManifest;
}

export function readManifest(paths: HelperSkillPaths): HelperSkillOwnershipManifest | null {
  const stat = lstat(paths.manifestPath);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail("HELPER_SKILL_MANIFEST_INVALID", `Ownership manifest is not a regular file: ${paths.manifestPath}`);
  }
  try {
    return validateManifest(JSON.parse(fs.readFileSync(paths.manifestPath, "utf8")), paths);
  } catch (error) {
    if (error instanceof HelperSkillError) throw error;
    fail("HELPER_SKILL_MANIFEST_INVALID", `Ownership manifest cannot be parsed: ${paths.manifestPath}`);
  }
}

export function projectionKey(skill: string, agent: HelperSkillAgent): string {
  return `${skill}\0${agent}`;
}

export function inspectManifest(manifest: HelperSkillOwnershipManifest, paths: HelperSkillPaths): InspectedOwnership {
  const canonical = new Map<string, "present" | "missing">();
  const projections = new Map<string, "present" | "missing">();
  const knownNames = new Set(manifest.skills.map(skill => skill.name));
  const rootStat = lstat(paths.ssotRoot);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Canonical Skill root changed type: ${paths.ssotRoot}`);
  }
  if (rootStat) {
    const extras = fs.readdirSync(paths.ssotRoot).filter(name => !knownNames.has(name));
    if (extras.length) fail("HELPER_SKILL_OWNERSHIP_CONFLICT", "Canonical Skill root contains unowned entries.", { extras });
  }

  for (const target of manifest.targets) {
    const stat = lstat(target.skillsDir);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Agent Skill directory changed type: ${target.skillsDir}`);
    }
    if (stat && resolvedDirectory(target.skillsDir) !== target.resolvedSkillsDir) {
      fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Agent Skill directory resolves to a different target: ${target.skillsDir}`);
    }
    assertNoOverlap(paths.ssotRoot, target.skillsDir, `${target.agent} target and canonical root`);
  }

  for (const skill of manifest.skills) {
    const canonicalStat = lstat(skill.canonicalPath);
    if (!canonicalStat) canonical.set(skill.name, "missing");
    else {
      if (skill.intentionalDeletion || !canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) {
        fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Canonical Skill ownership changed: ${skill.canonicalPath}`);
      }
      const actual = hashDirectory(skill.canonicalPath);
      if (actual !== skill.contentHash) {
        fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Canonical Skill was modified outside the helper: ${skill.canonicalPath}`, { expected: skill.contentHash, actual });
      }
      canonical.set(skill.name, "present");
    }

    for (const projection of skill.projections) {
      const stat = lstat(projection.path);
      const key = projectionKey(skill.name, projection.agent);
      if (!stat) {
        projections.set(key, "missing");
        continue;
      }
      if (projection.intentionalDeletion) {
        fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `A deliberately removed projection was replaced externally: ${projection.path}`);
      }
      if (projection.mode === "symlink") {
        if (!stat.isSymbolicLink()) fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Managed symlink changed type: ${projection.path}`);
        const target = fs.readlinkSync(projection.path);
        const resolved = path.resolve(path.dirname(projection.path), target);
        if (resolved !== path.resolve(skill.canonicalPath)) {
          fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Managed symlink changed target: ${projection.path}`, { target });
        }
      } else {
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Managed copy changed type: ${projection.path}`);
        const actual = hashDirectory(projection.path);
        if (actual !== projection.contentHash) {
          fail("HELPER_SKILL_OWNERSHIP_CONFLICT", `Managed copy was modified outside the helper: ${projection.path}`, { expected: projection.contentHash, actual });
        }
      }
      projections.set(key, "present");
    }
  }
  return { canonical, projections };
}

export function manifestFindings(manifest: HelperSkillOwnershipManifest, paths: HelperSkillPaths): HelperSkillFinding[] {
  const findings: HelperSkillFinding[] = [];
  const rootStat = lstat(paths.ssotRoot);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    findings.push({ code: "canonical_type_changed", path: paths.ssotRoot, message: "Canonical Skill root changed type." });
    return findings;
  }
  const knownNames = new Set(manifest.skills.map(skill => skill.name));
  if (rootStat) {
    for (const name of fs.readdirSync(paths.ssotRoot)) {
      if (!knownNames.has(name)) findings.push({ code: "unowned_canonical_entry", path: path.join(paths.ssotRoot, name), message: "Canonical root contains an unowned entry." });
    }
  }
  for (const skill of manifest.skills) {
    const canonicalStat = lstat(skill.canonicalPath);
    if (skill.intentionalDeletion) {
      if (canonicalStat) findings.push({ code: "deleted_skill_reappeared", path: skill.canonicalPath, message: "An intentionally deleted Skill reappeared." });
    } else if (!canonicalStat) findings.push({ code: "canonical_missing", path: skill.canonicalPath, message: "Managed canonical Skill is missing." });
    else if (!canonicalStat.isDirectory() || canonicalStat.isSymbolicLink()) findings.push({ code: "canonical_type_changed", path: skill.canonicalPath, message: "Managed canonical Skill changed type." });
    else {
      try {
        if (hashDirectory(skill.canonicalPath) !== skill.contentHash) findings.push({ code: "canonical_modified", path: skill.canonicalPath, message: "Managed canonical Skill content changed." });
      } catch { findings.push({ code: "canonical_unreadable", path: skill.canonicalPath, message: "Managed canonical Skill cannot be hashed." }); }
    }
    for (const projection of skill.projections) {
      const stat = lstat(projection.path);
      if (projection.intentionalDeletion) {
        if (stat) findings.push({ code: "deleted_projection_reappeared", path: projection.path, message: "An intentionally deleted projection reappeared." });
        continue;
      }
      if (!stat) {
        findings.push({ code: "projection_missing", path: projection.path, message: "Managed Skill projection is missing." });
        continue;
      }
      if (projection.mode === "symlink") {
        if (!stat.isSymbolicLink()) findings.push({ code: "projection_type_changed", path: projection.path, message: "Managed symlink changed type." });
        else {
          const target = path.resolve(path.dirname(projection.path), fs.readlinkSync(projection.path));
          if (target !== path.resolve(skill.canonicalPath)) findings.push({ code: "projection_target_changed", path: projection.path, message: "Managed symlink changed target." });
        }
      } else if (!stat.isDirectory() || stat.isSymbolicLink()) findings.push({ code: "projection_type_changed", path: projection.path, message: "Managed copy changed type." });
      else {
        try {
          if (hashDirectory(projection.path) !== projection.contentHash) findings.push({ code: "projection_modified", path: projection.path, message: "Managed copy content changed." });
        } catch { findings.push({ code: "projection_unreadable", path: projection.path, message: "Managed copy cannot be hashed." }); }
      }
    }
  }
  return findings;
}
