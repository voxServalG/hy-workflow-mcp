import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJson, ensureParent, projectPaths, userRoots, type ProjectPaths } from "../runtime/user-paths.js";
import { SetupFailure, type SetupAction } from "./types.js";
import { internalSetupTestHooks } from "./test-hooks.js";

type FileSnapshot = {
  file: string;
  existed: boolean;
  before: string | null;
  beforeHash: string | null;
  mode: number | null;
  expectedHash?: string | null;
  appliedHash?: string | null;
};

type DirectoryRemoval = {
  target: string;
  tombstone: string;
  state: "intent" | "staged";
};

export type ClientResourceEvidence = {
  resource: string;
  action?: "install" | "remove";
  previous?: unknown;
  desired?: unknown;
  appliedExact?: boolean;
};

type TransactionJournal = {
  schemaVersion: "1";
  id: string;
  action: SetupAction;
  projectRoot: string;
  projectId: string;
  pid: number;
  host: string;
  startedAt: string;
  phase: "intent" | "applying" | "rollback" | "committed";
  resources: FileSnapshot[];
  clientResources: Array<string | ClientResourceEvidence>;
  directoryResources?: DirectoryRemoval[];
};

type LockOwner = {
  pid: number;
  host: string;
  createdAt: string;
  transactionId: string;
  token: string;
};

type LockObservation = {
  owner: LockOwner | null;
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
};

type ReclaimMarker = { token: string };

const OWNERLESS_LOCK_GRACE_MS = 60_000;
const RECLAIM_MARKER = ".reclaim.json";

function hash(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(file: string): FileSnapshot {
  if (!fs.existsSync(file)) return { file, existed: false, before: null, beforeHash: null, mode: null };
  const value = fs.readFileSync(file);
  return { file, existed: true, before: value.toString("base64"), beforeHash: hash(value), mode: fs.statSync(file).mode & 0o777 };
}

function currentHash(file: string): string | null {
  return fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
}

function restore(item: FileSnapshot): void {
  if (!item.existed) {
    fs.rmSync(item.file, { force: true });
    return;
  }
  ensureParent(item.file);
  const temporary = `${item.file}.${process.pid}.${randomUUID()}.rollback`;
  fs.writeFileSync(temporary, Buffer.from(item.before ?? "", "base64"), { mode: item.mode ?? 0o600, flag: "wx" });
  fs.renameSync(temporary, item.file);
}

function processAlive(owner: LockOwner): boolean {
  if (owner.host !== os.hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (error: any) { return error?.code === "EPERM"; }
}

function readOwner(file: string): LockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (!Number.isInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.host !== "string" || !value.host
      || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))
      || typeof value.transactionId !== "string" || !value.transactionId
      || typeof value.token !== "string" || !/^[0-9a-f-]{36}$/i.test(value.token)) return null;
    return {
      pid: Number(value.pid),
      host: value.host,
      createdAt: value.createdAt,
      transactionId: value.transactionId,
      token: value.token,
    };
  }
  catch { return null; }
}

function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid
    && left.host === right.host
    && left.createdAt === right.createdAt
    && left.transactionId === right.transactionId
    && left.token === right.token;
}

function observeLock(lock: string): LockObservation | null {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(lock); }
  catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new SetupFailure(
      "lock_busy",
      "SETUP_LOCK_BUSY",
      `Setup lock path is not a safe directory: ${lock}`,
      "Preserve the path and run hy-workflow doctor --offline --json before retrying.",
      { lock },
      true,
    );
  }
  return {
    owner: readOwner(path.join(lock, "owner.json")),
    dev: stat.dev,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    mtimeMs: stat.mtimeMs,
  };
}

function sameLock(left: LockObservation, right: LockObservation | null): boolean {
  if (!right) return false;
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs
    && sameOwner(left.owner, right.owner);
}

function markerOwned(file: string, token: string): boolean {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ReclaimMarker>;
    return value.token === token;
  } catch {
    return false;
  }
}

function releaseMarker(file: string, token: string): void {
  if (markerOwned(file, token)) fs.rmSync(file, { force: true });
}

function restoreUnexpectedTombstone(lock: string, tombstone: string): boolean {
  if (fs.existsSync(lock)) return false;
  try {
    fs.renameSync(tombstone, lock);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lock: string, expected: LockOwner): void {
  const current = readOwner(path.join(lock, "owner.json"));
  if (!sameOwner(current, expected)) return;

  const tombstone = `${lock}.release-${randomUUID()}`;
  try { fs.renameSync(lock, tombstone); }
  catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }

  const moved = readOwner(path.join(tombstone, "owner.json"));
  if (sameOwner(moved, expected)) {
    fs.rmSync(tombstone, { recursive: true, force: true });
    return;
  }
  restoreUnexpectedTombstone(lock, tombstone);
}

async function reclaimStaleLock(lock: string, observed: LockObservation): Promise<boolean> {
  await internalSetupTestHooks().afterSetupLockStaleObserved?.(lock);

  const token = randomUUID();
  const marker = path.join(lock, RECLAIM_MARKER);
  try {
    fs.writeFileSync(marker, `${JSON.stringify({ token } satisfies ReclaimMarker)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error: any) {
    if (error?.code === "EEXIST" || error?.code === "ENOENT") return false;
    throw error;
  }

  let moved = false;
  let tombstone = "";
  try {
    // Creating the marker serializes reclaimers. Re-check both the directory
    // identity and owner after claiming it so an observation of an older lock
    // can never be applied to a replacement lock.
    if (!sameLock(observed, observeLock(lock))) return false;

    tombstone = `${lock}.stale-${randomUUID()}`;
    try { fs.renameSync(lock, tombstone); }
    catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    moved = true;

    const movedObservation = observeLock(tombstone);
    if (!sameLock(observed, movedObservation) || !markerOwned(path.join(tombstone, RECLAIM_MARKER), token)) {
      if (restoreUnexpectedTombstone(lock, tombstone)) moved = false;
      throw new SetupFailure(
        "lock_busy",
        "SETUP_LOCK_BUSY",
        "The setup lock changed while stale-lock recovery was claiming it.",
        "Wait for the current operation to finish, then retry setup.",
        { lock, tombstone },
        true,
      );
    }

    // Only the unique tombstone is removed. The shared lock path is never
    // deleted after a stale observation, so a newly published owner survives.
    fs.rmSync(tombstone, { recursive: true, force: true });
    moved = false;
    return true;
  } finally {
    if (!moved) releaseMarker(path.join(lock, RECLAIM_MARKER), token);
  }
}

function rollbackDirectoryCandidates(root: string, paths: ProjectPaths): string[] {
  const roots = userRoots();
  const candidates = [
    path.join(root, ".github", "workflows"),
    path.join(root, ".github"),
    paths.configDir,
    path.dirname(paths.configDir),
    paths.stateDir,
    path.dirname(paths.stateDir),
    paths.cacheDir,
    path.dirname(paths.cacheDir),
    roots.config,
    roots.state,
    roots.cache,
  ];
  for (const ownedRoot of [roots.config, roots.state, roots.cache]) {
    const parent = path.dirname(ownedRoot);
    if (path.basename(parent).toLowerCase() === "hy-workflow") candidates.push(parent);
  }
  return [...new Set(candidates.map(candidate => path.resolve(candidate)))];
}

function pruneEmptyDirectories(directories: string[]): void {
  for (const directory of [...directories].sort((left, right) => right.length - left.length)) {
    try { fs.rmdirSync(directory); }
    catch (error: any) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) throw error;
    }
  }
}

async function acquire(root: string, transactionId: string, waitMs = 30_000): Promise<() => void> {
  const lock = projectPaths(root).setupLock;
  ensureParent(lock);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      const owner: LockOwner = {
        pid: process.pid,
        host: os.hostname(),
        createdAt: new Date().toISOString(),
        transactionId,
        token: randomUUID(),
      };
      const ownerDelay = Number(internalSetupTestHooks().ownerDelayMs ?? 0);
      if (Number.isFinite(ownerDelay) && ownerDelay > 0) await new Promise(resolve => setTimeout(resolve, ownerDelay));
      fs.writeFileSync(path.join(lock, "owner.json"), `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      return () => releaseLock(lock, owner);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const observed = observeLock(lock);
      if (!observed) continue;
      const owner = observed.owner;
      const age = owner ? Date.now() - Date.parse(owner.createdAt) : Date.now() - observed.mtimeMs;
      // A complete same-host owner record lets us prove the process is gone and
      // reclaim immediately. The grace period is only for mkdir -> owner.json,
      // where another live process may still be publishing its ownership.
      if ((owner && !processAlive(owner)) || (!owner && age > OWNERLESS_LOCK_GRACE_MS)) {
        if (await reclaimStaleLock(lock, observed)) continue;
      }
      const current = observeLock(lock);
      if (!current) continue;
      if (Date.now() >= deadline) {
        const currentOwner = current.owner;
        throw new SetupFailure(
          "lock_busy",
          "SETUP_LOCK_BUSY",
          "Another hy-workflow setup transaction is still active.",
          "Wait for it to finish, or run hy-workflow doctor --offline --json if the owner process no longer exists.",
          { lock, owner: currentOwner },
          true,
        );
      }
      // A reclaimer may have replaced the observed lock while this attempt was
      // waiting. Re-enter the loop and inspect the current owner afresh.
      if (!sameLock(observed, current)) continue;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}

export type SetupTransaction = {
  id: string;
  capture(files: string[]): void;
  assertCaptured(file: string, expectedBeforeHash: string | null): void;
  prepareExpected(file: string, expectedHash: string | null): void;
  markApplied(files: string[]): void;
  prepareDirectoryRemoval(target: string, tombstone: string): void;
  markDirectoryStaged(target: string, tombstone: string): void;
  markClient(resource: string, evidence?: Omit<ClientResourceEvidence, "resource">): void;
  unmarkClient(resource: string): void;
};

export function setupFailpoint(resource: string): void {
  if (internalSetupTestHooks().failAt !== resource) return;
  throw new SetupFailure(
    "transaction",
    "SETUP_TRANSACTION_FAILED",
    `Injected setup failure at ${resource}.`,
    "This deterministic failpoint is intended for acceptance testing only.",
    { resource, injected: true },
  );
}

function clientResourceName(value: string | ClientResourceEvidence): string {
  return typeof value === "string" ? value : value.resource;
}

function rollbackFile(item: FileSnapshot): "unchanged" | "restore" | "manual" {
  const current = currentHash(item.file);
  if (current === item.beforeHash) return "unchanged";
  if (item.appliedHash !== undefined) return current === item.appliedHash ? "restore" : "manual";
  if (item.expectedHash !== undefined) {
    return current === item.expectedHash ? "restore" : "manual";
  }
  // Legacy journals and writes that never persisted an intent are safe only
  // when the resource still matches the captured before image.
  return "manual";
}

function rollbackDirectories(resources: DirectoryRemoval[]): string[] {
  const manual: string[] = [];
  for (const item of [...resources].reverse()) {
    const targetExists = fs.existsSync(item.target);
    const tombstoneExists = fs.existsSync(item.tombstone);
    if (targetExists && !tombstoneExists) continue;
    if (!targetExists && tombstoneExists) {
      try { fs.renameSync(item.tombstone, item.target); }
      catch { manual.push(item.target); }
      continue;
    }
    if (!targetExists && !tombstoneExists && item.state === "intent") continue;
    manual.push(item.target);
  }
  return manual;
}

function finishDirectories(resources: DirectoryRemoval[]): string[] {
  const manual: string[] = [];
  for (const item of resources) {
    if (fs.existsSync(item.target)) { manual.push(item.target); continue; }
    if (!fs.existsSync(item.tombstone)) continue;
    internalSetupTestHooks().beforeDirectoryCleanup?.(item.tombstone);
    if (internalSetupTestHooks().failDirectoryCleanup) { manual.push(item.tombstone); continue; }
    try { fs.rmSync(item.tombstone, { recursive: true, force: true }); }
    catch { manual.push(item.tombstone); }
    if (fs.existsSync(item.tombstone) && !manual.includes(item.tombstone)) manual.push(item.tombstone);
  }
  return manual;
}

export function recoverSetupJournal(
  root: string,
  reconcileClient?: (resource: ClientResourceEvidence) => boolean,
): { recovered: boolean; manual: string[]; clientResources?: Array<string | ClientResourceEvidence> } {
  const file = projectPaths(root).setupJournal;
  if (!fs.existsSync(file)) return { recovered: false, manual: [] };
  let journal: TransactionJournal;
  try { journal = JSON.parse(fs.readFileSync(file, "utf-8")); }
  catch (error: any) {
    throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Setup journal is unreadable: ${file}`, "Preserve the file and run hy-workflow doctor --offline --json.", { file, cause: error?.message ?? String(error) });
  }
  const clientResources = journal.clientResources ?? [];
  const directoryResources = journal.directoryResources ?? [];
  const manual: string[] = [];
  if (journal.phase === "committed") {
    manual.push(...clientResources.map(clientResourceName), ...finishDirectories(directoryResources));
    if (!manual.length) fs.rmSync(file, { force: true });
    return { recovered: !manual.length, manual, ...(clientResources.length ? { clientResources } : {}) };
  }
  // Client commands can share one physical config file. Recover them in the
  // same reverse order as in-process rollback so sibling mutations unwind
  // before the mutation that created their shared container.
  for (const resource of [...clientResources].reverse()) {
    if (typeof resource === "string" || !reconcileClient) { manual.push(clientResourceName(resource)); continue; }
    try { if (!reconcileClient(resource)) manual.push(resource.resource); }
    catch { manual.push(resource.resource); }
  }
  manual.push(...rollbackDirectories(directoryResources));
  for (const item of [...journal.resources].reverse()) {
    const decision = rollbackFile(item);
    if (decision === "manual") manual.push(item.file);
    else if (decision === "restore") restore(item);
  }
  if (!manual.length) fs.rmSync(file, { force: true });
  return { recovered: !manual.length, manual, ...(clientResources.length ? { clientResources } : {}) };
}

export async function withSetupTransaction<T>(
  root: string,
  action: SetupAction,
  callback: (transaction: SetupTransaction) => Promise<T> | T,
  recovery: { reconcileClient?: (resource: ClientResourceEvidence) => boolean } = {},
): Promise<T> {
  const paths = projectPaths(root);
  const absentDirectories = rollbackDirectoryCandidates(root, paths).filter(directory => !fs.existsSync(directory));
  const id = randomUUID();
  const release = await acquire(root, id);
  let existing: ReturnType<typeof recoverSetupJournal>;
  try {
    existing = recoverSetupJournal(root, recovery.reconcileClient);
  } catch (error) {
    // The lock belongs to this invocation. An unreadable or otherwise
    // unrecoverable journal must never strand it before the main try/finally.
    release();
    pruneEmptyDirectories(absentDirectories);
    throw error;
  }
  if (existing.manual.length) {
    release();
    pruneEmptyDirectories(absentDirectories);
    throw new SetupFailure(
      "transaction",
      "SETUP_TRANSACTION_FAILED",
      "An interrupted setup transaction requires manual reconciliation.",
      "Run hy-workflow doctor --offline --json and follow its recovery steps before retrying.",
      existing,
    );
  }
  const journal: TransactionJournal = {
    schemaVersion: "1",
    id,
    action,
    projectRoot: paths.identity.root,
    projectId: paths.identity.id,
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    phase: "intent",
    resources: [],
    clientResources: [],
    directoryResources: [],
  };
  const persist = (): void => atomicWriteJson(paths.setupJournal, journal);
  persist();
  const transaction: SetupTransaction = {
    id,
    capture(files) {
      for (const file of files) if (!journal.resources.some(item => item.file === file)) journal.resources.push(snapshot(file));
      journal.phase = "applying";
      persist();
    },
    assertCaptured(file, expectedBeforeHash) {
      const item = journal.resources.find(value => value.file === file);
      if (!item) throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Preflight baseline was not captured: ${file}`, undefined, { file, transactionId: id });
      if (item.beforeHash !== expectedBeforeHash) {
        throw new SetupFailure(
          "transaction",
          "SETUP_TRANSACTION_FAILED",
          `Resource changed between locked preflight and transaction capture: ${file}`,
          "Review the external change, then rerun setup. No setup write was attempted.",
          { file, preflightHash: expectedBeforeHash, capturedHash: item.beforeHash, transactionId: id },
          true,
        );
      }
    },
    prepareExpected(file, expectedHash) {
      const item = journal.resources.find(value => value.file === file);
      if (!item) throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Write intent was not captured: ${file}`, "Rerun doctor; setup will not write an uncaptured resource.", { file, transactionId: id });
      const actual = currentHash(file);
      if (actual !== item.beforeHash) {
        throw new SetupFailure(
          "transaction",
          "SETUP_TRANSACTION_FAILED",
          `Resource changed after setup preflight: ${file}`,
          "Review the external change, then rerun setup. The concurrent content was preserved.",
          { file, beforeHash: item.beforeHash, currentHash: actual, expectedHash, transactionId: id },
          true,
        );
      }
      item.expectedHash = expectedHash;
      persist();
    },
    markApplied(files) {
      for (const file of files) {
        const item = journal.resources.find(value => value.file === file);
        if (item) {
          const actual = currentHash(file);
          if (item.expectedHash !== undefined && actual !== item.expectedHash) {
            throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Atomic write produced an unexpected hash: ${file}`, "Run hy-workflow doctor --offline --json; the journal was kept.", { file, expectedHash: item.expectedHash, actualHash: actual, transactionId: id });
          }
          item.appliedHash = actual;
        }
      }
      persist();
    },
    prepareDirectoryRemoval(target, tombstone) {
      const relative = path.relative(path.dirname(target), tombstone);
      if (path.dirname(target) !== path.dirname(tombstone) || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Unsafe staged directory mapping: ${target} -> ${tombstone}`);
      }
      const existing = journal.directoryResources?.find(item => item.target === target);
      if (existing && existing.tombstone !== tombstone) throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Directory removal was already staged with a different target: ${target}`);
      if (!existing) journal.directoryResources?.push({ target, tombstone, state: "intent" });
      persist();
    },
    markDirectoryStaged(target, tombstone) {
      const item = journal.directoryResources?.find(value => value.target === target && value.tombstone === tombstone);
      if (!item) throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", `Directory removal intent was not journaled: ${target}`);
      item.state = "staged";
      persist();
    },
    markClient(resource, evidence = {}) {
      const index = journal.clientResources.findIndex(item => clientResourceName(item) === resource);
      if (index >= 0) journal.clientResources[index] = { resource, ...evidence };
      else journal.clientResources.push({ resource, ...evidence });
      persist();
    },
    unmarkClient(resource) {
      journal.clientResources = journal.clientResources.filter(item => clientResourceName(item) !== resource);
      persist();
    },
  };
  let committed = false;
  try {
    let result: T;
    try {
      result = await callback(transaction);
      const directoryConflicts = (journal.directoryResources ?? []).filter(item => item.state === "staged" && fs.existsSync(item.target)).map(item => item.target);
      if (directoryConflicts.length) {
        throw new SetupFailure(
          "transaction",
          "SETUP_TRANSACTION_FAILED",
          "A staged project directory was recreated before unset committed.",
          "Preserve both the recreated directory and staged tombstone; run doctor and reconcile them manually.",
          { conflicts: directoryConflicts, transactionId: id },
          true,
        );
      }
    } catch (error) {
      journal.phase = "rollback";
      persist();
      const conflicts: string[] = [...rollbackDirectories(journal.directoryResources ?? [])];
      for (const item of [...journal.resources].reverse()) {
        const decision = rollbackFile(item);
        if (decision === "manual") { conflicts.push(item.file); continue; }
        if (decision === "restore") {
          try { restore(item); } catch { conflicts.push(item.file); }
        }
      }
      if (!conflicts.length && !journal.clientResources.length) fs.rmSync(paths.setupJournal, { force: true });
      if (conflicts.length) {
        throw new SetupFailure("transaction", "SETUP_TRANSACTION_FAILED", "Setup failed and one or more resources changed during rollback.", "Run hy-workflow doctor --offline --json; the journal was kept.", { conflicts, cause: error instanceof Error ? error.message : String(error), transactionId: id });
      }
      throw error;
    }
    journal.clientResources = [];
    journal.phase = "committed";
    persist();
    const cleanup = finishDirectories(journal.directoryResources ?? []);
    if (cleanup.length) {
      throw new SetupFailure("unset", "SETUP_UNSET_INCOMPLETE", "Local deployment committed, but staged directories could not be removed.", "Run hy-workflow doctor --offline --json to retry durable cleanup.", { cleanup, transactionId: id });
    }
    fs.rmSync(paths.setupJournal, { force: true });
    committed = true;
    return result;
  } finally {
    release();
    if (!committed) pruneEmptyDirectories(absentDirectories);
  }
}
