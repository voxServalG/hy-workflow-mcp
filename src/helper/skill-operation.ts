import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ProjectionTransaction,
  recoverProjectionJournal,
} from "./skill-projection.js";
import {
  copyDirectory,
  ensureDirectory,
  lstat,
  pruneCreatedDirectories,
  removeResource,
  stagePath,
} from "./skill-fs.js";
import { PROJECTION_RUNTIME } from "./skill-manifest.js";
import {
  HelperSkillError,
  fail,
  type HelperSkillFaultHooks,
  type HelperSkillOwnershipManifest,
  type HelperSkillPaths,
  type HelperSkillProjectionMode,
  type HelperSkillProjectionPreference,
  type HelperSkillTargetRecord,
} from "./skill-types.js";

export function prepareProjection(
  canonicalPath: string,
  destination: string,
  preference: HelperSkillProjectionPreference,
  transaction: ProjectionTransaction,
  created: string[],
  hooks?: HelperSkillFaultHooks,
): { prepared: string; mode: HelperSkillProjectionMode } {
  ensureDirectory(path.dirname(destination), created);
  const prepared = stagePath(destination);
  transaction.trackTemporary(prepared);
  const symlink = hooks?.createSymlink ?? ((target: string, link: string) => {
    const relative = path.relative(path.dirname(link), target);
    if (process.platform === "win32") fs.symlinkSync(target, link, "junction");
    else fs.symlinkSync(relative, link, "dir");
  });
  if (preference !== "copy") {
    try {
      symlink(canonicalPath, prepared);
      return { prepared, mode: "symlink" };
    } catch (error) {
      removeResource(prepared);
      if (preference === "symlink") throw error;
    }
  }
  copyDirectory(canonicalPath, prepared);
  return { prepared, mode: "copy" };
}

export function prepareManifest(
  manifest: HelperSkillOwnershipManifest,
  paths: HelperSkillPaths,
  transaction: ProjectionTransaction,
  created: string[],
): string {
  ensureDirectory(path.dirname(paths.manifestPath), created);
  const prepared = stagePath(paths.manifestPath);
  transaction.trackTemporary(prepared);
  fs.writeFileSync(prepared, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return prepared;
}

type ProjectionLockOwner = {
  pid: number;
  token: string;
  createdAt: string;
};

const OWNERLESS_LOCK_GRACE_MS = 60_000;

function readProjectionLockOwner(lockPath: string): ProjectionLockOwner | null {
  const file = path.join(lockPath, "owner.json");
  const stat = lstat(file);
  if (!stat?.isFile() || stat.isSymbolicLink()) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token)
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
    return { pid: Number(value.pid), token: value.token, createdAt: value.createdAt };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code !== "ESRCH";
  }
}

function writeProjectionLockOwner(lockPath: string): ProjectionLockOwner {
  const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: "wx" });
  return owner;
}

function releaseProjectionLock(lockPath: string, owner: ProjectionLockOwner): void {
  const current = readProjectionLockOwner(lockPath);
  if (current?.pid === owner.pid && current.token === owner.token) {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function acquireLock(paths: HelperSkillPaths): () => void {
  fs.mkdirSync(path.dirname(paths.lockPath), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.mkdirSync(paths.lockPath);
      const owner = writeProjectionLockOwner(paths.lockPath);
      try {
        recoverProjectionJournal(paths, PROJECTION_RUNTIME);
      } catch (error) {
        releaseProjectionLock(paths.lockPath, owner);
        throw error;
      }
      return () => releaseProjectionLock(paths.lockPath, owner);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
    }

    const lockStat = lstat(paths.lockPath);
    if (!lockStat?.isDirectory() || lockStat.isSymbolicLink()) {
      fail("HELPER_SKILL_BUSY", `Skill projection lock path is not a safe directory: ${paths.lockPath}`);
    }
    const staleOwner = readProjectionLockOwner(paths.lockPath);
    const ownerlessAgeMs = staleOwner
      ? 0
      : Math.max(0, Date.now() - lockStat.mtimeMs);
    if (
      (staleOwner && processIsAlive(staleOwner.pid))
      || (!staleOwner && ownerlessAgeMs <= OWNERLESS_LOCK_GRACE_MS)
    ) {
      fail("HELPER_SKILL_BUSY", `Another Skill projection operation is active: ${paths.lockPath}`);
    }

    const tombstone = `${paths.lockPath}.stale-${randomUUID()}`;
    try {
      fs.renameSync(paths.lockPath, tombstone);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    let owner: ProjectionLockOwner | null = null;
    try {
      fs.mkdirSync(paths.lockPath);
      owner = writeProjectionLockOwner(paths.lockPath);
      recoverProjectionJournal(paths, PROJECTION_RUNTIME);
      fs.rmSync(tombstone, { recursive: true, force: true });
      const acquired = owner;
      return () => releaseProjectionLock(paths.lockPath, acquired);
    } catch (error: any) {
      if (owner) releaseProjectionLock(paths.lockPath, owner);
      if (lstat(tombstone) && !lstat(paths.lockPath)) {
        try { fs.renameSync(tombstone, paths.lockPath); } catch {}
      } else if (lstat(tombstone)) {
        fs.rmSync(tombstone, { recursive: true, force: true });
      }
      if (error?.code === "EEXIST") continue;
      throw error;
    }
  }
  fail("HELPER_SKILL_BUSY", `Skill projection lock could not be acquired safely: ${paths.lockPath}`);
}

export function withLock<T>(paths: HelperSkillPaths, operation: () => T): T {
  const release = acquireLock(paths);
  try { return operation(); } finally { release(); }
}

export function runProjectedMutation<T>(
  paths: HelperSkillPaths,
  targets: HelperSkillTargetRecord[],
  hooks: HelperSkillFaultHooks | undefined,
  preflight: ReadonlyMap<string, string | null>,
  operation: (transaction: ProjectionTransaction, created: string[]) => T,
): T {
  const transaction = new ProjectionTransaction(paths, targets, hooks, preflight, PROJECTION_RUNTIME);
  const created: string[] = [];
  try {
    const result = operation(transaction, created);
    transaction.commit();
    return result;
  } catch (error) {
    try { transaction.rollback(); } catch (rollbackError) { throw rollbackError; }
    pruneCreatedDirectories(created);
    throw error;
  }
}

export function busySkillStatus(paths: HelperSkillPaths): never {
  throw new HelperSkillError("HELPER_SKILL_BUSY", `Another Skill projection operation is active: ${paths.lockPath}`);
}
