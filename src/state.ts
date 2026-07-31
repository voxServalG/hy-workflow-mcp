import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_STAGE_BY_PHASE,
  PHASES,
  VALID_TRANSITIONS,
  canonicalWorkflowStage,
  isPhase,
  type Phase,
  type WorkflowStage,
} from "./runtime/state-machine.js";
import { configuredBaseBranch, currentGitBranch, findProjectRoot, resolveGitPrivatePath } from "./runtime/project.js";
import { createHash, randomUUID } from "node:crypto";
import { atomicWriteJson, ensureParent, projectPaths } from "./runtime/user-paths.js";
import { parseMergeReceipt, type MergeReceipt } from "./merge-recovery.js";

// ── Types ────────────────────────────────────────────────────

export type { Phase };
export { PHASES, VALID_TRANSITIONS };

// ── DocsGraph types ────────────────────────────────────────

export interface DocsGraphLink {
  anchor: string;
  target: string;
  line: number;
}

export interface DocsGraphEntry {
  path: string;
  sha256: string;
  links: DocsGraphLink[];
  referencedBy: string[];
}

export interface DocsGraph {
  digest: string;
  docsDir: string;
  entryPoints: string[];
  entries: Record<string, DocsGraphEntry>;
}



export interface CheckItem {
  command: string;
  expected_exit: number;
  description: string;
}

export interface PlanDoc {
  task: string;

  scope: {
    changes: string[];
    new_files: string[];
    delete: string[];
  };

  boundary: {
    dependency_dag: string;
    entry_points: string[];
    no_new_external: boolean;
  };

  verify: {
    platform: {
      python_version: string;
      setup: string[];
    };
    smoke: CheckItem[];
    tests: CheckItem[];
  };

  risks: string[];
  discussion: string;

  // runtime
  branch: string | null;
  verify_hash: string | null;
  pr_number: number | null;
}

export interface ImplementationManifest {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  changed: string[];
}

export interface PlanScopeAmendment {
  changes: {
    add: string[];
    remove: string[];
  };
  new_files: {
    add: string[];
    remove: string[];
  };
  delete: {
    add: string[];
    remove: string[];
  };
}

export interface PendingPlanAmendment {
  reason: string;
  scope: PlanScopeAmendment;
  warnings: string[];
}

export type DocumentReadStage = "before_plan" | "before_approve" | "after_edit";

export interface DocumentReadFile {
  path: string;
  bytes: number;
  chars?: number;
  sha256: string;
  content?: string;
  truncated: boolean;
  omittedChars?: number;
  score?: number;
}

export interface DocumentReadSnapshot {
  stage: DocumentReadStage;
  time: string;
  task: string;
  planHash: string | null;
  docsDir: string;
  digest: string;
  files: DocumentReadFile[];
  docsGraphDigest: string;
  entryPoints: string[];
  traversalRoots: string[];
  budget?: {
    maxFiles: number;
    maxChars: number;
    maxFileChars: number;
    estimatedMaxTokens: number;
    selectedFiles: number;
    selectedChars: number;
    estimatedTokens: number;
    truncatedFiles: number;
  };
  pagination?: {
    cursor: string;
    offset: number;
    hasMore: boolean;
    nextCursor: string | null;
    omittedFiles: number;
  };
  changedSinceBaseline?: boolean;
  implementationFiles?: string[];
  implementationDigest?: string;
}

export interface DocumentReads {
  beforePlan?: DocumentReadSnapshot | null;
  beforeApprove?: DocumentReadSnapshot | null;
  afterEdit?: DocumentReadSnapshot | null;
}

export interface SyncDocsRecord {
  time: string;
  planHash: string;
  afterEditDigest: string;
  implementationDigest: string;
  allowedDocs: string[];
}

export type DocumentGateStatus = "missing" | "current" | "stale";
export type DocumentGateName = "beforePlan" | "beforeApprove" | "afterEdit" | "syncDocs";

export interface DocumentGateHealth {
  status: DocumentGateStatus;
  reason: string;
  expected?: string | null;
  actual?: string | null;
}

export interface DocumentReadHealth {
  planHash: string | null;
  gates: Record<DocumentGateName, DocumentGateHealth>;
  staleDocumentReads: DocumentGateName[];
  missingDocumentReads: DocumentGateName[];
  blockedBy: {
    gate: DocumentGateName;
    tool: "hy_read_docs" | "hy_sync_docs";
    arguments?: Record<string, string>;
    reason: string;
  } | null;
  okForApprove: boolean;
  okForVerify: boolean;
}

export interface Approval {
  time: string;
  note: string;
  /** Stable identity of the human decision. Optional for historical state. */
  decisionId?: string;
  /** Material PlanDoc hash approved by the user. Optional for historical state. */
  planHash?: string;
  /** Previous decision replaced by an explicitly approved material amendment. */
  supersedesDecisionId?: string;
  audit?: Array<{
    time: string;
    kind: "non_material_scope_narrowing";
    amendmentDecisionId: string;
    previousPlanHash: string;
    planHash: string;
  }>;
  /** Exact commit identity retained only for an unchanged publish retry. */
  commitRecovery?: unknown;
}

export interface PendingPlanApproval {
  time: string;
  note: string;
  decisionId: string;
  planHash: string;
}

export type ActiveExamCheckLayer = "compile" | "scope" | "boundary" | "platform" | "smoke" | "tests";

export interface ActiveExamCheck {
  id: string;
  layer: ActiveExamCheckLayer;
  command: string;
  cwd?: string;
  timeoutMs: number;
  expectExitCode: number;
  nonce: string;
  mustContain?: string;
  mustNotContain?: string;
}

/** Complete, resumable identity for one asynchronous verification suite. */
export interface ActiveExam {
  examId: string;
  issuedAt: string;
  expiresAt: string;
  scopeFingerprint: string;
  planHash: string;
  nonce: string;
  checks: ActiveExamCheck[];
}

/** Exact commit presentation bound before any Git or GitHub mutation. */
export interface CommitIntent {
  title: string;
  body: string;
  planHash: string;
  implementationDigest: string;
}

export interface WorkflowState {
  version: "1";
  phase: Phase;
  /** Persisted intra-phase progress. Optional only for historical state files. */
  stage?: WorkflowStage;
  branch: string | null;
  prNumber: number | null;
  plan: PlanDoc | null;
  approval: Approval | null;
  /** One explicit user approval waiting only for the automatic before_approve audit. */
  pendingApproval?: PendingPlanApproval | null;
  // deprecated — kept optional for reading historical state.json, no longer written
  verifyHash?: string | null;
  verifiedManifestHash?: string | null;
  verifiedImplementationDigest?: string | null;
  pendingAmendment?: PendingPlanAmendment | null;
  implementationManifest?: ImplementationManifest | null;
  documentReads?: DocumentReads | null;
  syncDocs?: SyncDocsRecord | null;
  mergeReceipt?: MergeReceipt | null;
  /** Current long-running verification binding, persisted for status recovery. */
  activeExam?: ActiveExam | null;
  /** Exact commit and PR title/body, persisted for cross-session retries. */
  commitIntent?: CommitIntent | null;
}

// ── State path ───────────────────────────────────────────────

export interface LegacyRuntimeDiagnostic {
  file: string;
  tracked: boolean;
  message: string;
  remediation?: string;
}

export function statePath(): string {
  return projectPaths(projectRoot()).workflowState;
}

export type MergeLockOwner = { pid: number; host: string; createdAt: string; token: string };
export type MergeLockResult =
  | { ok: true; path: string; owner: MergeLockOwner; release: () => void }
  | { ok: false; path: string; owner: MergeLockOwner | null; cause?: string };

function readMergeLockOwner(file: string): MergeLockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0 || typeof value.host !== "string" || !value.host || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.token !== "string" || !value.token) return null;
    return value as MergeLockOwner;
  } catch { return null; }
}

function mergeLockOwnerAlive(owner: MergeLockOwner): boolean {
  if (owner.host !== os.hostname()) return true;
  try { process.kill(owner.pid, 0); return true; }
  catch (caught: any) { return caught?.code === "EPERM"; }
}

export function acquireMergeLock(graceMs = 60_000): MergeLockResult {
  const lock = `${statePath()}.merge.lock`;
  const ownerFile = path.join(lock, "owner.json");
  const owner: MergeLockOwner = { pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), token: randomUUID() };
  ensureParent(lock);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let created = false;
    try {
      fs.mkdirSync(lock);
      created = true;
      atomicWriteJson(ownerFile, owner);
      return {
        ok: true,
        path: lock,
        owner,
        release: () => {
          const current = readMergeLockOwner(ownerFile);
          if (current?.token !== owner.token) return;
          const tombstone = `${lock}.release-${owner.token}`;
          try { fs.renameSync(lock, tombstone); fs.rmSync(tombstone, { recursive: true, force: true }); }
          catch (caught: any) { if (caught?.code !== "ENOENT") throw caught; }
        },
      };
    } catch (caught: any) {
      if (created) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
        return { ok: false, path: lock, owner: null, cause: caught?.message ?? String(caught) };
      }
      if (caught?.code !== "EEXIST") return { ok: false, path: lock, owner: null, cause: caught?.message ?? String(caught) };
      const current = readMergeLockOwner(ownerFile);
      let age = 0;
      try { age = Date.now() - fs.statSync(lock).mtimeMs; } catch {}
      if (!((current && !mergeLockOwnerAlive(current)) || (!current && age > graceMs))) return { ok: false, path: lock, owner: current };
      const tombstone = `${lock}.stale-${owner.token}`;
      try { fs.renameSync(lock, tombstone); fs.rmSync(tombstone, { recursive: true, force: true }); }
      catch (reclaim: any) { if (reclaim?.code !== "ENOENT") return { ok: false, path: lock, owner: current, cause: reclaim?.message ?? String(reclaim) }; }
    }
  }
  return { ok: false, path: lock, owner: readMergeLockOwner(ownerFile) };
}

export function scopePath(): string {
  return projectPaths(projectRoot()).scope;
}

export function projectRoot(): string {
  return findProjectRoot(process.cwd());
}

export function legacyRuntimeDiagnostics(root = projectRoot()): LegacyRuntimeDiagnostic[] {
  // Compatibility export only. Normal runtime must not inspect legacy project
  // paths because their mere presence must be invisible after upgrade.
  void root;
  return [];
}

export function cleanupLegacyRuntimeFiles(root = projectRoot()): void {
  void root;
}

// ── Read / Write ─────────────────────────────────────────────

function structuredWorkflowStateError(code: string, message: string, detail?: Record<string, unknown>): never {
  throw {
    type: "workflow_state",
    subtype: "invalid_phase",
    code,
    message,
    hint: "Inspect or remove the external user workflow-state file named in error.detail.file, then retry from hy_status. Project-local legacy state is not consulted.",
    detail,
    retryable: false,
  };
}

function initialState(): WorkflowState {
  return {
    version: "1",
    phase: "init",
    stage: "init.ready",
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    pendingApproval: null,
    verifiedImplementationDigest: null,
    pendingAmendment: null,
    implementationManifest: null,
    documentReads: null,
    syncDocs: null,
    mergeReceipt: null,
    activeExam: null,
    commitIntent: null,
  };
}

export function createInitialWorkflowState(): WorkflowState {
  return initialState();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeNullablePrNumber(value: unknown, file: string): number | null {
  if (value === null || value === undefined) return null;
  if (Number.isSafeInteger(value) && (value as number) > 0) return value as number;
  structuredWorkflowStateError("WORKFLOW_STATE_INVALID_PR_NUMBER", `Workflow state has an invalid prNumber in ${file}.`, { file, prNumber: value });
}

function normalizeMergeReceipt(value: unknown, file: string): MergeReceipt | null {
  if (value === null || value === undefined) return null;
  const receipt = parseMergeReceipt(value);
  if (!receipt) structuredWorkflowStateError("WORKFLOW_STATE_INVALID_MERGE_RECEIPT", `Workflow state has an invalid mergeReceipt in ${file}.`, { file });
  return receipt;
}

function isPlanHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{12}$/.test(value);
}
const ACTIVE_EXAM_LAYERS = new Set<ActiveExamCheckLayer>(["compile", "scope", "boundary", "platform", "smoke", "tests"]);

function normalizeActiveExam(value: unknown, phase: Phase, plan: PlanDoc | null, file: string): ActiveExam | null {
  if (value === null || value === undefined) return null;
  const invalid = (): never => structuredWorkflowStateError(
    "WORKFLOW_STATE_INVALID_ACTIVE_EXAM",
    `Workflow state has an invalid activeExam in ${file}.`,
    { file },
  );
  if (!isObject(value)
      || phase !== "verify"
      || typeof value.examId !== "string" || !/^[0-9a-f]{16,}$/.test(value.examId)
      || typeof value.issuedAt !== "string" || !Number.isFinite(Date.parse(value.issuedAt))
      || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
      || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
      || typeof value.scopeFingerprint !== "string" || !/^[0-9a-f]{12}$/.test(value.scopeFingerprint)
      || !isPlanHash(value.planHash)
      || value.planHash !== computePlanHash(plan)
      || typeof value.nonce !== "string" || !/^[0-9a-f]{16,}$/.test(value.nonce)
      || !Array.isArray(value.checks) || value.checks.length === 0) {
    return invalid();
  }
  const seenIds = new Set<string>();
  const checks: ActiveExamCheck[] = value.checks.map(raw => {
    if (!isObject(raw)
        || typeof raw.id !== "string" || !raw.id.trim() || seenIds.has(raw.id)
        || typeof raw.layer !== "string" || !ACTIVE_EXAM_LAYERS.has(raw.layer as ActiveExamCheckLayer)
        || typeof raw.command !== "string" || !raw.command.trim()
        || raw.cwd !== undefined && (typeof raw.cwd !== "string" || !raw.cwd.trim())
        || !Number.isSafeInteger(raw.timeoutMs) || (raw.timeoutMs as number) <= 0
        || !Number.isSafeInteger(raw.expectExitCode)
        || typeof raw.nonce !== "string" || !/^[0-9a-f]{16,}$/.test(raw.nonce)
        || raw.mustContain !== undefined && typeof raw.mustContain !== "string"
        || raw.mustNotContain !== undefined && typeof raw.mustNotContain !== "string") {
      return invalid();
    }
    seenIds.add(raw.id);
    return { ...raw } as unknown as ActiveExamCheck;
  });
  return { ...value, checks } as unknown as ActiveExam;
}

function normalizeCommitIntent(
  value: unknown,
  phase: Phase,
  plan: PlanDoc | null,
  verifiedImplementationDigest: string | null,
  file: string,
): CommitIntent | null {
  if (value === null || value === undefined) return null;
  if (!isObject(value)
      || phase !== "commit"
      || typeof value.title !== "string" || !value.title.trim()
      || typeof value.body !== "string"
      || !isPlanHash(value.planHash) || value.planHash !== computePlanHash(plan)
      || !isPlanHash(value.implementationDigest)
      || value.implementationDigest !== verifiedImplementationDigest) {
    structuredWorkflowStateError(
      "WORKFLOW_STATE_INVALID_COMMIT_INTENT",
      `Workflow state has an invalid commitIntent in ${file}.`,
      { file },
    );
  }
  return { ...value } as unknown as CommitIntent;
}

function hasValidApprovalAuditChain(value: unknown, decisionId: string, planHash: string): boolean {
  const match = /^plan:([a-f0-9]{12})$/.exec(decisionId);
  if (!match) return false;
  const audit = value === undefined ? [] : value;
  if (!Array.isArray(audit)) return false;
  let current = match[1];
  for (const item of audit) {
    if (!isObject(item)
        || typeof item.time !== "string" || !item.time.trim()
        || item.kind !== "non_material_scope_narrowing"
        || typeof item.amendmentDecisionId !== "string" || !item.amendmentDecisionId.trim()
        || !isPlanHash(item.previousPlanHash)
        || !isPlanHash(item.planHash)
        || item.previousPlanHash !== current) {
      return false;
    }
    current = item.planHash;
  }
  return current === planHash;
}

function hasValidApprovalCore(value: unknown): value is Approval {
  if (!isObject(value) || typeof value.time !== "string" || !value.time.trim() || typeof value.note !== "string") return false;
  const hasDecisionId = value.decisionId !== undefined;
  const hasPlanHash = value.planHash !== undefined;
  if (hasDecisionId !== hasPlanHash) return false;
  if (!hasDecisionId && !hasPlanHash) {
    return value.audit === undefined && value.supersedesDecisionId === undefined;
  }
  if (typeof value.decisionId !== "string" || !isPlanHash(value.planHash)) return false;
  if (!hasValidApprovalAuditChain(value.audit, value.decisionId, value.planHash)) return false;
  if (value.supersedesDecisionId !== undefined && (typeof value.supersedesDecisionId !== "string" || !value.supersedesDecisionId.trim())) return false;
  return true;
}

function normalizeApproval(value: unknown, plan: PlanDoc | null, file: string): Approval | null {
  if (value === null || value === undefined) return null;
  if (!hasValidApprovalCore(value)) {
    structuredWorkflowStateError(
      "WORKFLOW_STATE_INVALID_APPROVAL",
      `Workflow state has an invalid approval in ${file}.`,
      { file },
    );
  }
  const approval = { ...value } as Approval;
  if (approval.planHash === undefined && plan) {
    const planHash = computePlanHash(plan);
    if (planHash) {
      approval.planHash = planHash;
      approval.decisionId = approval.decisionId ?? `plan:${planHash}`;
    }
  }
  return approval;
}

function normalizePendingApproval(value: unknown, plan: PlanDoc | null, file: string): PendingPlanApproval | null {
  if (value === null || value === undefined) return null;
  const planHash = computePlanHash(plan);
  if (!isObject(value)
      || typeof value.time !== "string" || !value.time.trim()
      || typeof value.note !== "string"
      || !isPlanHash(value.planHash)
      || value.decisionId !== `plan:${value.planHash}`
      || !planHash
      || value.planHash !== planHash) {
    structuredWorkflowStateError(
      "WORKFLOW_STATE_INVALID_PENDING_APPROVAL",
      `Workflow state has an invalid pending approval in ${file}.`,
      { file },
    );
  }
  return { ...value } as unknown as PendingPlanApproval;
}

function normalizeDocumentReadSnapshot(value: unknown): DocumentReadSnapshot | null {
  if (!isObject(value)) return null;
  const {
    purpose: _legacyPurpose,
    findings: _legacyFindings,
    ...facts
  } = value;
  return facts as unknown as DocumentReadSnapshot;
}

function normalizeDocumentReads(value: unknown): DocumentReads | null {
  if (!isObject(value)) return null;
  const normalized: Record<string, unknown> = { ...value };
  for (const key of ["beforePlan", "beforeApprove", "afterEdit"] as const) {
    if (!(key in value)) continue;
    normalized[key] = value[key] === null
      ? null
      : normalizeDocumentReadSnapshot(value[key]);
  }
  return normalized as unknown as DocumentReads;
}

function normalizeState(raw: unknown, file: string): WorkflowState {
  if (!isObject(raw)) {
    structuredWorkflowStateError("WORKFLOW_STATE_INVALID", `Workflow state is not an object: ${file}.`, { file });
  }

  const phase = raw.phase;
  if (typeof phase !== "string" || !isPhase(phase)) {
    structuredWorkflowStateError("WORKFLOW_STATE_INVALID_PHASE", `Workflow state has an invalid phase in ${file}.`, { file, phase });
  }

  const plan = (isObject(raw.plan) ? raw.plan : null) as PlanDoc | null;
  const verifiedImplementationDigest = normalizeNullableString(raw.verifiedImplementationDigest);

  return {
    ...initialState(),
    ...raw,
    version: "1",
    phase,
    stage: canonicalWorkflowStage(phase, raw.stage),
    branch: normalizeNullableString(raw.branch),
    prNumber: normalizeNullablePrNumber(raw.prNumber, file),
    plan,
    approval: normalizeApproval(raw.approval, plan, file),
    pendingApproval: normalizePendingApproval(raw.pendingApproval, plan, file),
    verifyHash: normalizeNullableString(raw.verifyHash),
    verifiedImplementationDigest,
    verifiedManifestHash: normalizeNullableString(raw.verifiedManifestHash),
    pendingAmendment: (isObject(raw.pendingAmendment) ? raw.pendingAmendment : null) as PendingPlanAmendment | null,
    implementationManifest: (isObject(raw.implementationManifest) ? raw.implementationManifest : null) as ImplementationManifest | null,
    documentReads: normalizeDocumentReads(raw.documentReads),
    syncDocs: (isObject(raw.syncDocs) ? raw.syncDocs : null) as SyncDocsRecord | null,
    mergeReceipt: normalizeMergeReceipt(raw.mergeReceipt, file),
    activeExam: normalizeActiveExam(raw.activeExam, phase, plan, file),
    commitIntent: normalizeCommitIntent(raw.commitIntent, phase, plan, verifiedImplementationDigest, file),
  };
}

function parseWorkflowStateFile(file: string): WorkflowState {
  try {
    return normalizeState(JSON.parse(fs.readFileSync(file, "utf-8")), file);
  } catch (e: any) {
    if (e?.type === "workflow_state") throw e;
    structuredWorkflowStateError("WORKFLOW_STATE_CORRUPT", `Workflow state file is not valid JSON: ${file}.`, { file, cause: e?.message ?? String(e) });
  }
}

export function readState(): WorkflowState {
  const p = statePath();
  if (!fs.existsSync(p)) return initialState();
  return parseWorkflowStateFile(p);
}

export function writeState(state: WorkflowState): void {
  atomicWriteJson(statePath(), {
    ...state,
    stage: canonicalWorkflowStage(state.phase, state.stage),
  });
}

// ── Phase transitions ────────────────────────────────────────

export function assertPhase(state: WorkflowState, ...expected: Phase[]): void {
  if (!expected.includes(state.phase)) {
    throw new StateError(
      `Phase "${state.phase}" is not in [${expected.join(", ")}]. ` +
      `You may need to call a prior tool first. Current valid transitions: ` +
      `${VALID_TRANSITIONS[state.phase]?.join(" → ") ?? "none"}.`
    );
  }
}

export function transition(state: WorkflowState, to: Phase): WorkflowState {
  const allowed = VALID_TRANSITIONS[state.phase];
  if (!allowed?.includes(to)) {
    throw new StateError(
      `Cannot transition from "${state.phase}" to "${to}". ` +
      `Allowed transitions from "${state.phase}": ${allowed?.join(", ") ?? "none"}.`
    );
  }
  return {
    ...state,
    phase: to,
    stage: DEFAULT_STAGE_BY_PHASE[to],
    activeExam: to === "verify" ? state.activeExam ?? null : null,
    commitIntent: to === "commit" ? state.commitIntent ?? null : null,
  };
}

export function supersedeCommitRecoveryAfterVerification(approval: Approval | null): Approval | null {
  if (!approval || !Object.prototype.hasOwnProperty.call(approval, "commitRecovery")) return approval;
  const { commitRecovery: _superseded, ...currentApproval } = approval;
  return currentApproval;
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

// ── Hash ─────────────────────────────────────────────────────

function shortHash(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex").slice(0, 12);
}

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

export function computeImplementationDigest(root: string, manifest: ImplementationManifest): string {
  const files = sorted(manifest.changed).map(file => {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) return { file, sha256: "deleted" };
    const hash = createHash("sha256");
    hash.update(fs.readFileSync(fullPath));
    return { file, sha256: hash.digest("hex") };
  });
  return shortHash(JSON.stringify(files));
}

export function computePlanHash(plan: PlanDoc | null): string | null {
  if (!plan) return null;
  const payload = JSON.stringify({
    task: plan.task,
    scope: plan.scope,
    boundary: plan.boundary,
    verify: plan.verify,
    risks: plan.risks,
    discussion: plan.discussion,
  });
  const hash = createHash("sha256");
  hash.update(payload);
  return hash.digest("hex").slice(0, 12);
}

export function planDecisionId(plan: PlanDoc | null): string | null {
  const planHash = computePlanHash(plan);
  return planHash ? `plan:${planHash}` : null;
}

export function amendmentDecisionId(plan: PlanDoc | null, amendment: PendingPlanAmendment | null | undefined): string | null {
  const planHash = computePlanHash(plan);
  if (!planHash || !amendment) return null;
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ planHash, reason: amendment.reason, scope: amendment.scope, warnings: amendment.warnings }));
  return `amendment:${hash.digest("hex").slice(0, 12)}`;
}

export function approvalMatchesPlan(approval: Approval | null, plan: PlanDoc | null): boolean {
  if (!approval || !plan) return false;
  if (!hasValidApprovalCore(approval)) return false;
  const planHash = computePlanHash(plan);
  if (!planHash) return false;
  // Historical approvals predate planHash. They remain valid for the already
  // persisted PlanDoc so upgrading an active project does not interrupt it.
  return approval.planHash === undefined || approval.planHash === planHash;
}

export function pendingApprovalMatchesPlan(pending: PendingPlanApproval | null | undefined, plan: PlanDoc | null): boolean {
  if (!pending || !plan) return false;
  const planHash = computePlanHash(plan);
  return Boolean(
    planHash
    && typeof pending.time === "string" && pending.time.trim()
    && typeof pending.note === "string"
    && isPlanHash(pending.planHash)
    && pending.planHash === planHash
    && pending.decisionId === `plan:${planHash}`,
  );
}

export function createPlanApproval(plan: PlanDoc, note = "", previous?: Approval | null): Approval {
  const planHash = computePlanHash(plan)!;
  const decisionId = `plan:${planHash}`;
  return {
    time: new Date().toISOString(),
    note,
    decisionId,
    planHash,
    ...(previous?.decisionId && previous.decisionId !== decisionId
      ? { supersedesDecisionId: previous.decisionId }
      : {}),
  };
}

export function rebindApprovalForNonMaterialNarrowing(
  approval: Approval | null,
  previousPlan: PlanDoc,
  nextPlan: PlanDoc,
  amendmentId: string,
): Approval {
  if (!approvalMatchesPlan(approval, previousPlan)) {
    throw new StateError("Cannot rebind a scope narrowing without an approval bound to the previous PlanDoc.");
  }
  const previousPlanHash = computePlanHash(previousPlan)!;
  const planHash = computePlanHash(nextPlan)!;
  const decisionId = approval?.decisionId ?? `plan:${previousPlanHash}`;
  return {
    ...(approval ?? { time: new Date().toISOString(), note: "" }),
    decisionId,
    planHash,
    audit: [
      ...(approval?.audit ?? []),
      {
        time: new Date().toISOString(),
        kind: "non_material_scope_narrowing",
        amendmentDecisionId: amendmentId,
        previousPlanHash,
        planHash,
      },
    ],
  };
}

function gate(status: DocumentGateStatus, reason: string, expected?: string | null, actual?: string | null): DocumentGateHealth {
  return { status, reason, expected, actual };
}

export function documentReadHealth(state: WorkflowState, currentImplementationDigest?: string): DocumentReadHealth {
  const planHash = computePlanHash(state.plan);
  const reads = state.documentReads ?? {};
  const beforePlan = reads.beforePlan ?? null;
  const beforeApprove = reads.beforeApprove ?? null;
  const afterEdit = reads.afterEdit ?? null;
  const syncDocs = state.syncDocs ?? null;

  const gates: Record<DocumentGateName, DocumentGateHealth> = {
    beforePlan: !beforePlan
      ? gate("missing", "before_plan document baseline is missing.")
      : state.plan && beforePlan.task !== state.plan.task
        ? gate("current", "before_plan baseline exists; task text differs from the current PlanDoc task.", state.plan.task, beforePlan.task)
        : gate("current", "before_plan document baseline matches the current task."),
    beforeApprove: !beforeApprove
      ? gate("missing", "before_approve document audit is missing.")
      : !planHash || beforeApprove.planHash !== planHash
        ? gate("stale", "before_approve plan hash does not match the current PlanDoc.", planHash, beforeApprove.planHash)
        : beforeApprove.changedSinceBaseline
          ? gate("current", "before_approve detected document changes since before_plan. Review their relevance, but digest drift alone does not invalidate the approved PlanDoc.", beforePlan?.digest ?? null, beforeApprove.digest)
          : gate("current", "before_approve document audit matches the current PlanDoc."),
    afterEdit: !afterEdit
      ? gate("missing", "after_edit document audit is missing.")
      : !planHash || afterEdit.planHash !== planHash
        ? gate("stale", "after_edit plan hash does not match the current PlanDoc.", planHash, afterEdit.planHash)
        : currentImplementationDigest && afterEdit.implementationDigest !== currentImplementationDigest
          ? gate("stale", "after_edit implementation digest does not match the current implementation diff.", currentImplementationDigest, afterEdit.implementationDigest)
          : gate("current", "after_edit document audit matches the current PlanDoc and implementation diff."),
    syncDocs: !syncDocs
      ? gate("missing", "hy_sync_docs record is missing.")
      : !planHash || syncDocs.planHash !== planHash
        ? gate("stale", "hy_sync_docs plan hash does not match the current PlanDoc.", planHash, syncDocs.planHash)
        : afterEdit && syncDocs.afterEditDigest !== afterEdit.digest
          ? gate("stale", "hy_sync_docs was recorded for a different after_edit document audit.", afterEdit.digest, syncDocs.afterEditDigest)
          : currentImplementationDigest && syncDocs.implementationDigest !== currentImplementationDigest
            ? gate("stale", "hy_sync_docs implementation digest does not match the current implementation diff.", currentImplementationDigest, syncDocs.implementationDigest)
            : gate("current", "hy_sync_docs record matches the current PlanDoc and after_edit audit."),
  };

  const staleDocumentReads = (Object.keys(gates) as DocumentGateName[]).filter(name => gates[name].status === "stale");
  const missingDocumentReads = (Object.keys(gates) as DocumentGateName[]).filter(name => gates[name].status === "missing");
  const okForApprove = gates.beforeApprove.status === "current";
  const okForVerify = gates.afterEdit.status === "current" && gates.syncDocs.status === "current";

  let blockedBy: DocumentReadHealth["blockedBy"] = null;
  if (state.phase === "approve" && !okForApprove) {
    blockedBy = { gate: "beforeApprove", tool: "hy_read_docs", arguments: { stage: "before_approve" }, reason: gates.beforeApprove.reason };
  } else if ((state.phase === "edit" || state.phase === "verify") && gates.afterEdit.status !== "current") {
    blockedBy = { gate: "afterEdit", tool: "hy_read_docs", arguments: { stage: "after_edit" }, reason: gates.afterEdit.reason };
  } else if ((state.phase === "edit" || state.phase === "verify") && gates.syncDocs.status !== "current") {
    blockedBy = { gate: "syncDocs", tool: "hy_sync_docs", reason: gates.syncDocs.reason };
  }

  return { planHash, gates, staleDocumentReads, missingDocumentReads, blockedBy, okForApprove, okForVerify };
}

// ── Branch name ──────────────────────────────────────────────

export function currentBranch(root: string): string {
  return currentGitBranch(root);
}

export function getBaseBranch(root: string): string {
  return configuredBaseBranch(root);
}
