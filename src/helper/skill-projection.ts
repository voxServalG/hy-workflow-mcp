import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

type ProjectionAgent = "codex" | "claude" | "opencode";
type ProjectionPreference = "auto" | "symlink" | "copy";

type ProjectionPaths = {
  stateRoot: string;
  ssotRoot: string;
  manifestPath: string;
};

type ProjectionTargetRecord = {
  agent: ProjectionAgent;
  skillsDir: string;
  resolvedSkillsDir: string;
  preference: ProjectionPreference;
};

type ProjectionFaultHooks = {
  afterMutation?: (destination: string, mutationIndex: number) => void;
  beforeMutation?: (destination: string, mutationIndex: number) => void;
};

export type ProjectionRuntime = {
  skillNames: readonly string[];
  agents: readonly ProjectionAgent[];
  fail: (code: string, message: string, detail?: Record<string, unknown>) => never;
  isHelperSkillError: (error: unknown) => boolean;
  lstat: (file: string) => fs.Stats | null;
  normalizeTargets: (
    targets: Array<Pick<ProjectionTargetRecord, "agent" | "skillsDir">>,
    preference: "auto",
    ssotRoot: string,
  ) => ProjectionTargetRecord[];
  removeResource: (file: string) => void;
  publishPreparedNoReplace: (prepared: string, destination: string) => void;
  resourceFingerprint: (file: string) => string | null;
};

type TransactionRecord = {
  destination: string;
  backup: string;
  prepared: string | null;
  expectedBefore: string | null;
  expectedAfter: string | null;
};

type ProjectionJournal = {
  schemaVersion: "1";
  phase: "mutating" | "committed";
  pid: number;
  createdAt: string;
  updatedAt: string;
  canonicalRoot: string;
  manifestPath: string;
  targets: ProjectionTargetRecord[];
  records: TransactionRecord[];
  temporaries: string[];
};

export function projectionJournalPath(paths: ProjectionPaths): string {
  return path.join(paths.stateRoot, "skill-projector-journal.json");
}

export function projectionJournalWritePath(paths: ProjectionPaths): string {
  return projectionJournalPath(paths) + ".write";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSiblingArtifact(candidate: string, destination: string, kind: "backup" | "stage"): boolean {
  const normalizedCandidate = path.resolve(candidate);
  const normalizedDestination = path.resolve(destination);
  if (path.dirname(normalizedCandidate) !== path.dirname(normalizedDestination)) return false;
  const prefix = `.${path.basename(normalizedDestination)}.hy-${kind}-`;
  const suffix = path.basename(normalizedCandidate).slice(prefix.length);
  return path.basename(normalizedCandidate).startsWith(prefix)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suffix);
}

function journalDestinations(paths: ProjectionPaths, targets: ProjectionTargetRecord[], runtime: ProjectionRuntime): Set<string> {
  const destinations = new Set<string>([
    path.resolve(paths.ssotRoot),
    path.resolve(paths.manifestPath),
  ]);
  for (const target of targets) {
    for (const name of runtime.skillNames) destinations.add(path.join(target.skillsDir, name));
  }
  return destinations;
}

function validateProjectionJournal(value: unknown, paths: ProjectionPaths, runtime: ProjectionRuntime): ProjectionJournal {
  const invalid = (reason: string): never =>
    runtime.fail("HELPER_SKILL_JOURNAL_INVALID", `Invalid Skill projection journal: ${reason}`);
  if (!isObject(value)) invalid("root object");
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== "1"
    || !["mutating", "committed"].includes(String(root.phase))
    || !Number.isInteger(root.pid) || Number(root.pid) <= 0
    || typeof root.createdAt !== "string" || !Number.isFinite(Date.parse(root.createdAt))
    || typeof root.updatedAt !== "string" || !Number.isFinite(Date.parse(root.updatedAt))
    || typeof root.canonicalRoot !== "string" || path.resolve(root.canonicalRoot) !== path.resolve(paths.ssotRoot)
    || typeof root.manifestPath !== "string" || path.resolve(root.manifestPath) !== path.resolve(paths.manifestPath)
    || !Array.isArray(root.targets) || !Array.isArray(root.records) || !Array.isArray(root.temporaries)) {
    invalid("root fields");
  }

  const rawTargets = root.targets as unknown[];
  const targetRecords: ProjectionTargetRecord[] = [];
  const seenAgents = new Set<string>();
  for (const candidate of rawTargets) {
    if (!isObject(candidate)) invalid("target object");
    const item = candidate as Record<string, unknown>;
    if (!runtime.agents.includes(item.agent as ProjectionAgent)
      || typeof item.skillsDir !== "string" || !path.isAbsolute(item.skillsDir)
      || typeof item.resolvedSkillsDir !== "string" || !path.isAbsolute(item.resolvedSkillsDir)
      || !["auto", "symlink", "copy"].includes(String(item.preference))
      || seenAgents.has(String(item.agent))) invalid("target record");
    seenAgents.add(String(item.agent));
    targetRecords.push(item as unknown as ProjectionTargetRecord);
  }
  let normalizedTargets: ProjectionTargetRecord[];
  try {
    normalizedTargets = runtime.normalizeTargets(
      targetRecords.map(({ agent, skillsDir }) => ({ agent, skillsDir })),
      "auto",
      paths.ssotRoot,
    );
  } catch (error) {
    if (runtime.isHelperSkillError(error)) invalid("target path invariants");
    throw error;
  }
  const normalizedByAgent = new Map(normalizedTargets.map(target => [target.agent, target]));
  for (const target of targetRecords) {
    const normalized = normalizedByAgent.get(target.agent);
    if (!normalized
      || target.skillsDir !== normalized.skillsDir
      || target.resolvedSkillsDir !== normalized.resolvedSkillsDir) invalid("target path drift");
  }

  const destinations = journalDestinations(paths, targetRecords, runtime);
  const records: TransactionRecord[] = [];
  const seenDestinations = new Set<string>();
  for (const candidate of root.records as unknown[]) {
    if (!isObject(candidate)) invalid("transaction record");
    const item = candidate as Record<string, unknown>;
    const destination = typeof item.destination === "string" ? path.resolve(item.destination) : "";
    const backup = typeof item.backup === "string" ? path.resolve(item.backup) : "";
    const prepared = item.prepared === null
      ? null
      : typeof item.prepared === "string" ? path.resolve(item.prepared) : undefined;
    const expectedBefore = item.expectedBefore;
    const expectedAfter = item.expectedAfter;
    if (!destinations.has(destination) || seenDestinations.has(destination)
      || !isSiblingArtifact(backup, destination, "backup")
      || prepared === undefined || (prepared !== null && !isSiblingArtifact(prepared, destination, "stage"))
      || (expectedBefore !== null && (typeof expectedBefore !== "string" || expectedBefore.length > 8_192))
      || (expectedAfter !== null && (typeof expectedAfter !== "string" || expectedAfter.length > 8_192))) {
      invalid("transaction record fields");
    }
    seenDestinations.add(destination);
    records.push({ destination, backup, prepared: prepared as string | null, expectedBefore: expectedBefore as string | null, expectedAfter: expectedAfter as string | null });
  }

  const temporaries: string[] = [];
  const seenTemporaries = new Set<string>();
  for (const candidate of root.temporaries as unknown[]) {
    if (typeof candidate !== "string") invalid("temporary path");
    const temporary = path.resolve(candidate as string);
    if (seenTemporaries.has(temporary)
      || ![...destinations].some(destination => isSiblingArtifact(temporary, destination, "stage"))) {
      invalid("temporary path");
    }
    seenTemporaries.add(temporary);
    temporaries.push(temporary);
  }

  return {
    schemaVersion: "1",
    phase: root.phase as ProjectionJournal["phase"],
    pid: Number(root.pid),
    createdAt: root.createdAt as string,
    updatedAt: root.updatedAt as string,
    canonicalRoot: path.resolve(root.canonicalRoot as string),
    manifestPath: path.resolve(root.manifestPath as string),
    targets: targetRecords,
    records,
    temporaries,
  };
}

function removeJournalFile(file: string, runtime: ProjectionRuntime): void {
  const stat = runtime.lstat(file);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    runtime.fail("HELPER_SKILL_JOURNAL_INVALID", `Skill projection journal artifact is unsafe: ${file}`);
  }
  fs.rmSync(file, { force: true });
}

function writeProjectionJournal(paths: ProjectionPaths, journal: ProjectionJournal, runtime: ProjectionRuntime): void {
  const file = projectionJournalPath(paths);
  const prepared = projectionJournalWritePath(paths);
  removeJournalFile(prepared, runtime);
  journal.updatedAt = new Date().toISOString();
  const descriptor = fs.openSync(prepared, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(prepared, file);
  try {
    const directory = fs.openSync(path.dirname(file), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch {}
}

function projectionRollbackConflicts(journal: ProjectionJournal, runtime: ProjectionRuntime): string[] {
  const conflicts: string[] = [];
  for (const record of [...journal.records].reverse()) {
    const current = runtime.resourceFingerprint(record.destination);
    const backup = runtime.resourceFingerprint(record.backup);
    if (backup !== null) {
      if (record.expectedBefore === null || backup !== record.expectedBefore
        || (current !== null && current !== record.expectedAfter)) {
        conflicts.push(record.destination);
        continue;
      }
      if (current !== null) runtime.removeResource(record.destination);
      fs.renameSync(record.backup, record.destination);
      continue;
    }
    if (current === record.expectedBefore) continue;
    if (record.expectedBefore === null && current === record.expectedAfter) {
      if (current !== null) runtime.removeResource(record.destination);
      continue;
    }
    conflicts.push(record.destination);
  }
  return conflicts;
}

function finishCommittedProjection(journal: ProjectionJournal, runtime: ProjectionRuntime): string[] {
  const conflicts: string[] = [];
  for (const record of journal.records) {
    const current = runtime.resourceFingerprint(record.destination);
    if (current !== record.expectedAfter) {
      conflicts.push(record.destination);
      continue;
    }
    if (runtime.lstat(record.backup)) runtime.removeResource(record.backup);
  }
  return conflicts;
}

function cleanupProjectionTemporaries(journal: ProjectionJournal, runtime: ProjectionRuntime): void {
  for (const temporary of journal.temporaries) {
    if (runtime.lstat(temporary)) runtime.removeResource(temporary);
  }
  for (const record of journal.records) {
    if (record.prepared && runtime.lstat(record.prepared)) runtime.removeResource(record.prepared);
  }
}

export function recoverProjectionJournal(paths: ProjectionPaths, runtime: ProjectionRuntime): void {
  const file = projectionJournalPath(paths);
  const prepared = projectionJournalWritePath(paths);
  if (!runtime.lstat(file)) {
    removeJournalFile(prepared, runtime);
    return;
  }
  let journal: ProjectionJournal;
  try {
    journal = validateProjectionJournal(JSON.parse(fs.readFileSync(file, "utf8")), paths, runtime);
  } catch (error) {
    if (runtime.isHelperSkillError(error)) throw error;
    runtime.fail("HELPER_SKILL_JOURNAL_INVALID", `Skill projection journal cannot be parsed: ${file}`);
  }
  const conflicts = journal.phase === "committed"
    ? finishCommittedProjection(journal, runtime)
    : projectionRollbackConflicts(journal, runtime);
  if (conflicts.length) {
    runtime.fail("HELPER_SKILL_ROLLBACK_CONFLICT", "Crash recovery preserved resources changed by another writer.", { conflicts, journal: file });
  }
  cleanupProjectionTemporaries(journal, runtime);
  removeJournalFile(file, runtime);
  removeJournalFile(prepared, runtime);
}

export class ProjectionTransaction {
  private readonly journal: ProjectionJournal;
  private mutationIndex = 0;

  constructor(
    private readonly paths: ProjectionPaths,
    targets: ProjectionTargetRecord[],
    private readonly hooks: ProjectionFaultHooks | undefined,
    private readonly preflight: ReadonlyMap<string, string | null>,
    private readonly runtime: ProjectionRuntime,
  ) {
    const now = new Date().toISOString();
    this.journal = {
      schemaVersion: "1",
      phase: "mutating",
      pid: process.pid,
      createdAt: now,
      updatedAt: now,
      canonicalRoot: path.resolve(paths.ssotRoot),
      manifestPath: path.resolve(paths.manifestPath),
      targets: targets.map(target => ({ ...target })),
      records: [],
      temporaries: [],
    };
    writeProjectionJournal(this.paths, this.journal, this.runtime);
  }

  checkpoint(): void {
    writeProjectionJournal(this.paths, this.journal, this.runtime);
  }

  trackTemporary(temporary: string): void {
    const normalized = path.resolve(temporary);
    if (!this.journal.temporaries.includes(normalized)) {
      this.journal.temporaries.push(normalized);
      this.checkpoint();
    }
  }

  private expectedFingerprint(destination: string): string | null {
    if (!this.preflight.has(destination)) {
      this.runtime.fail("HELPER_SKILL_JOURNAL_INVALID", `Skill mutation lacks a preflight fingerprint: ${destination}`);
    }
    return this.preflight.get(destination)!;
  }

  private assertPreflightUnchanged(destination: string, mutationIndex: number): string | null {
    const expected = this.expectedFingerprint(destination);
    this.hooks?.beforeMutation?.(destination, mutationIndex);
    const actual = this.runtime.resourceFingerprint(destination);
    if (actual !== expected) {
      this.runtime.fail(
        "HELPER_SKILL_OWNERSHIP_CONFLICT",
        `Skill resource changed after ownership preflight: ${destination}`,
        { destination, expected, actual },
      );
    }
    return expected;
  }

  private discardRecord(record: TransactionRecord): void {
    const index = this.journal.records.lastIndexOf(record);
    if (index >= 0) this.journal.records.splice(index, 1);
    this.checkpoint();
  }

  private moveOwnedResourceToBackup(record: TransactionRecord): void {
    try {
      fs.renameSync(record.destination, record.backup);
    } catch (error) {
      this.discardRecord(record);
      this.runtime.fail(
        "HELPER_SKILL_OWNERSHIP_CONFLICT",
        `Skill resource disappeared during ownership exchange: ${record.destination}`,
        { destination: record.destination, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    const backupFingerprint = this.runtime.resourceFingerprint(record.backup);
    if (backupFingerprint !== record.expectedBefore) {
      if (!this.runtime.lstat(record.destination)) {
        fs.renameSync(record.backup, record.destination);
        this.discardRecord(record);
      }
      this.runtime.fail(
        "HELPER_SKILL_OWNERSHIP_CONFLICT",
        `Skill resource changed during ownership exchange: ${record.destination}`,
        { destination: record.destination, expected: record.expectedBefore, actual: backupFingerprint },
      );
    }
  }

  swap(prepared: string, destination: string): void {
    const normalizedPrepared = path.resolve(prepared);
    const normalizedDestination = path.resolve(destination);
    const mutationIndex = this.mutationIndex + 1;
    const expectedBefore = this.assertPreflightUnchanged(normalizedDestination, mutationIndex);
    const expectedAfter = this.runtime.resourceFingerprint(normalizedPrepared);
    if (expectedAfter === null) {
      this.runtime.fail("HELPER_SKILL_JOURNAL_INVALID", `Prepared Skill resource disappeared: ${normalizedPrepared}`);
    }
    const record: TransactionRecord = {
      destination: normalizedDestination,
      backup: path.join(path.dirname(normalizedDestination), `.${path.basename(normalizedDestination)}.hy-backup-${randomUUID()}`),
      prepared: normalizedPrepared,
      expectedBefore,
      expectedAfter,
    };
    this.journal.records.push(record);
    this.checkpoint();
    if (expectedBefore !== null) this.moveOwnedResourceToBackup(record);
    try {
      this.runtime.publishPreparedNoReplace(normalizedPrepared, normalizedDestination);
    } catch (error) {
      if (expectedBefore === null && this.runtime.resourceFingerprint(normalizedDestination) !== null) {
        this.discardRecord(record);
        this.runtime.fail(
          "HELPER_SKILL_OWNERSHIP_CONFLICT",
          `Skill destination appeared during exclusive publication: ${normalizedDestination}`,
          { destination: normalizedDestination },
        );
      }
      throw error;
    }
    if (this.runtime.resourceFingerprint(normalizedDestination) !== expectedAfter) {
      this.runtime.fail("HELPER_SKILL_ROLLBACK_CONFLICT", `Published Skill fingerprint changed unexpectedly: ${normalizedDestination}`);
    }
    this.mutationIndex = mutationIndex;
    this.hooks?.afterMutation?.(normalizedDestination, mutationIndex);
  }

  remove(destination: string): void {
    const normalizedDestination = path.resolve(destination);
    const mutationIndex = this.mutationIndex + 1;
    const expectedBefore = this.assertPreflightUnchanged(normalizedDestination, mutationIndex);
    if (expectedBefore === null) return;
    const record: TransactionRecord = {
      destination: normalizedDestination,
      backup: path.join(path.dirname(normalizedDestination), `.${path.basename(normalizedDestination)}.hy-backup-${randomUUID()}`),
      prepared: null,
      expectedBefore,
      expectedAfter: null,
    };
    this.journal.records.push(record);
    this.checkpoint();
    this.moveOwnedResourceToBackup(record);
    this.mutationIndex = mutationIndex;
    this.hooks?.afterMutation?.(normalizedDestination, mutationIndex);
  }

  rollback(): void {
    const conflicts = projectionRollbackConflicts(this.journal, this.runtime);
    if (conflicts.length) {
      this.runtime.fail("HELPER_SKILL_ROLLBACK_CONFLICT", "Rollback preserved resources changed by another writer.", { conflicts });
    }
    cleanupProjectionTemporaries(this.journal, this.runtime);
    removeJournalFile(projectionJournalPath(this.paths), this.runtime);
    removeJournalFile(projectionJournalWritePath(this.paths), this.runtime);
  }

  commit(): void {
    this.journal.phase = "committed";
    this.checkpoint();
    const conflicts = finishCommittedProjection(this.journal, this.runtime);
    if (conflicts.length) {
      this.runtime.fail("HELPER_SKILL_ROLLBACK_CONFLICT", "Commit cleanup found unexpected Skill resources.", { conflicts });
    }
    cleanupProjectionTemporaries(this.journal, this.runtime);
    removeJournalFile(projectionJournalPath(this.paths), this.runtime);
    removeJournalFile(projectionJournalWritePath(this.paths), this.runtime);
  }
}
