import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { lstat } from "./skill-fs.js";
import type { HelperSkillPaths } from "./skills.js";

type HelperOperationLockOwner = {
  pid: number;
  token: string;
  createdAt: string;
};

const OWNERLESS_LOCK_GRACE_MS = 60_000;

export class HelperOperationLockError extends Error {
  readonly type = "helper" as const;
  readonly subtype = "operation_lock" as const;
  readonly code = "HELPER_OPERATION_BUSY" as const;
  readonly retryable = true;

  constructor(message: string, readonly detail?: Record<string, unknown>) {
    super(message);
    this.name = "HelperOperationLockError";
  }
}

export function helperOperationLockPath(paths: HelperSkillPaths): string {
  return path.join(paths.stateRoot, "helper-operation.lock");
}

function readOwner(lockPath: string): HelperOperationLockOwner | null {
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

function writeOwner(lockPath: string): HelperOperationLockOwner {
  const owner = { pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return owner;
}

function releaseLock(lockPath: string, owner: HelperOperationLockOwner): void {
  const current = readOwner(lockPath);
  if (current?.pid === owner.pid && current.token === owner.token) {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

function busy(lockPath: string): never {
  throw new HelperOperationLockError(
    `Another helper lifecycle operation is active: ${lockPath}`,
    { lockPath },
  );
}

function acquireLock(paths: HelperSkillPaths): () => void {
  const lockPath = helperOperationLockPath(paths);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lockPath);
      created = true;
      const owner = writeOwner(lockPath);
      return () => releaseLock(lockPath, owner);
    } catch (error: any) {
      if (created) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw error;
      }
      if (error?.code !== "EEXIST") throw error;
    }

    const stat = lstat(lockPath);
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) busy(lockPath);
    const owner = readOwner(lockPath);
    const ownerlessAgeMs = owner ? 0 : Math.max(0, Date.now() - stat.mtimeMs);
    if ((owner && processIsAlive(owner.pid))
      || (!owner && ownerlessAgeMs <= OWNERLESS_LOCK_GRACE_MS)) busy(lockPath);

    const tombstone = `${lockPath}.stale-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, tombstone);
    } catch (error: any) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    fs.rmSync(tombstone, { recursive: true, force: true });
  }
  busy(lockPath);
}

export async function withHelperOperationLock<T>(
  paths: HelperSkillPaths,
  operation: () => Promise<T> | T,
): Promise<T> {
  const release = acquireLock(paths);
  try {
    return await operation();
  } finally {
    release();
  }
}
