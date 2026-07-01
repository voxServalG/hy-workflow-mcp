import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { PHASES, VALID_TRANSITIONS, isPhase, type Phase } from "./runtime/state-machine.js";
import { configuredBaseBranch, currentGitBranch, findProjectRoot, resolveGitPrivatePath } from "./runtime/project.js";
import { createHash } from "node:crypto";

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
  sha256: string;
  content: string;
  truncated: boolean;
}

export interface DocumentReadSnapshot {
  stage: DocumentReadStage;
  purpose: string;
  time: string;
  task: string;
  planHash: string | null;
  docsDir: string;
  digest: string;
  files: DocumentReadFile[];
  findings: string[];
  docsGraphDigest: string;
  entryPoints: string[];
  traversalRoots: string[];
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
}

export interface WorkflowState {
  version: "1";
  phase: Phase;
  branch: string | null;
  prNumber: number | null;
  plan: PlanDoc | null;
  approval: Approval | null;
  verifyHash: string | null;
  verifiedImplementationDigest?: string | null;
  verifiedManifestHash?: string | null;
  pendingAmendment?: PendingPlanAmendment | null;
  implementationManifest?: ImplementationManifest | null;
  documentReads?: DocumentReads | null;
  syncDocs?: SyncDocsRecord | null;
}

// ── State path ───────────────────────────────────────────────

const RUNTIME_STATE_FILE = path.join("hy-workflow", "workflow.json");
const RUNTIME_SCOPE_FILE = path.join("hy-workflow", "scope.json");
const LEGACY_STATE_FILE = path.join(".hy", "workflow.json");
const LEGACY_SCOPE_FILE = path.join(".hy", "scope.json");

export interface LegacyRuntimeDiagnostic {
  file: string;
  tracked: boolean;
  message: string;
  remediation?: string;
}

export function statePath(): string {
  return gitPrivatePath(projectRoot(), RUNTIME_STATE_FILE);
}

export function scopePath(): string {
  return gitPrivatePath(projectRoot(), RUNTIME_SCOPE_FILE);
}

function legacyStatePath(root: string): string {
  return path.join(root, LEGACY_STATE_FILE);
}

function legacyScopePath(root: string): string {
  return path.join(root, LEGACY_SCOPE_FILE);
}

function gitPrivatePath(root: string, relativePath: string): string {
  return resolveGitPrivatePath(root, relativePath);
}

export function projectRoot(): string {
  return findProjectRoot(process.cwd());
}

function isTracked(root: string, file: string): boolean | null {
  try {
    execSync(`git ls-files --error-unmatch -- "${file}"`, { cwd: root, stdio: "ignore" });
    return true;
  } catch (e: any) {
    if (e.status === 1) return false;
    return null;
  }
}

export function legacyRuntimeDiagnostics(root = projectRoot()): LegacyRuntimeDiagnostic[] {
  const diagnostics: LegacyRuntimeDiagnostic[] = [];
  for (const file of [LEGACY_STATE_FILE, LEGACY_SCOPE_FILE]) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    const tracked = isTracked(root, file);
    if (tracked === true) {
      diagnostics.push({
        file,
        tracked: true,
        message: `${file} is legacy hy-workflow runtime metadata tracked by Git and may block branch checkout.`,
        remediation: `Run git rm --cached ${file} and add .hy/ to .gitignore, then commit that cleanup.`,
      });
      continue;
    }
    if (tracked === null) {
      diagnostics.push({
        file,
        tracked: false,
        message: `${file} exists but Git tracking status could not be determined, so hy-workflow will not delete it automatically.`,
      });
    }
  }
  return diagnostics;
}

export function cleanupLegacyRuntimeFiles(root = projectRoot()): void {
  for (const file of [LEGACY_STATE_FILE, LEGACY_SCOPE_FILE]) {
    const fullPath = path.join(root, file);
    if (!fs.existsSync(fullPath)) continue;
    const tracked = isTracked(root, file);
    if (tracked === false) {
      try { fs.unlinkSync(fullPath); } catch {}
    }
  }
}

// ── Read / Write ─────────────────────────────────────────────

function structuredWorkflowStateError(code: string, message: string, detail?: Record<string, unknown>): never {
  throw {
    type: "workflow_state",
    subtype: "invalid_phase",
    code,
    message,
    hint: "Inspect or remove the Git-private hy-workflow runtime state, then retry from hy_status.",
    detail,
    retryable: false,
  };
}

function initialState(): WorkflowState {
  return {
    version: "1",
    phase: "init",
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
    verifiedImplementationDigest: null,
    verifiedManifestHash: null,
    pendingAmendment: null,
    implementationManifest: null,
    documentReads: null,
    syncDocs: null,
  };
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

function normalizeState(raw: unknown, file: string): WorkflowState {
  if (!isObject(raw)) {
    structuredWorkflowStateError("WORKFLOW_STATE_INVALID", `Workflow state is not an object: ${file}.`, { file });
  }

  const phase = raw.phase;
  if (typeof phase !== "string" || !isPhase(phase)) {
    structuredWorkflowStateError("WORKFLOW_STATE_INVALID_PHASE", `Workflow state has an invalid phase in ${file}.`, { file, phase });
  }

  return {
    ...initialState(),
    ...raw,
    version: "1",
    phase,
    branch: normalizeNullableString(raw.branch),
    prNumber: normalizeNullablePrNumber(raw.prNumber, file),
    plan: (isObject(raw.plan) ? raw.plan : null) as PlanDoc | null,
    approval: (isObject(raw.approval) ? raw.approval : null) as Approval | null,
    verifyHash: normalizeNullableString(raw.verifyHash),
    verifiedImplementationDigest: normalizeNullableString(raw.verifiedImplementationDigest),
    verifiedManifestHash: normalizeNullableString(raw.verifiedManifestHash),
    pendingAmendment: (isObject(raw.pendingAmendment) ? raw.pendingAmendment : null) as PendingPlanAmendment | null,
    implementationManifest: (isObject(raw.implementationManifest) ? raw.implementationManifest : null) as ImplementationManifest | null,
    documentReads: (isObject(raw.documentReads) ? raw.documentReads : null) as DocumentReads | null,
    syncDocs: (isObject(raw.syncDocs) ? raw.syncDocs : null) as SyncDocsRecord | null,
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
  const root = projectRoot();
  const p = statePath();
  if (!fs.existsSync(p)) {
    const legacy = legacyStatePath(root);
    if (fs.existsSync(legacy)) {
      const state = parseWorkflowStateFile(legacy);
      try {
        writeState(state);
        cleanupLegacyRuntimeFiles(root);
      } catch {}
      return state;
    }
    cleanupLegacyRuntimeFiles(root);
    return initialState();
  }
  cleanupLegacyRuntimeFiles(root);
  return parseWorkflowStateFile(p);
}

export function writeState(state: WorkflowState): void {
  const dir = path.dirname(statePath());
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf-8");
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
  return { ...state, phase: to };
}

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

// ── Hash ─────────────────────────────────────────────────────

export function computeVerifyHash(state: WorkflowState): string {
  const payload = JSON.stringify({
    plan: state.plan?.task,
    scope: state.plan?.scope,
    boundary: state.plan?.boundary,
    rubrics: state.plan?.verify,
    implementationDigest: state.verifiedImplementationDigest ?? null,
    manifestHash: state.verifiedManifestHash ?? computeImplementationManifestHash(state.implementationManifest),
  });
  const hash = createHash("sha256");
  hash.update(payload);
  return hash.digest("hex").slice(0, 12);
}

function shortHash(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);
  return hash.digest("hex").slice(0, 12);
}

function sorted(values: string[] | undefined): string[] {
  return [...(values ?? [])].sort();
}

export function computeImplementationManifestHash(manifest: ImplementationManifest | null | undefined): string | null {
  if (!manifest) return null;
  return shortHash(JSON.stringify({
    modified: sorted(manifest.modified),
    added: sorted(manifest.added),
    deleted: sorted(manifest.deleted),
    untracked: sorted(manifest.untracked),
    changed: sorted(manifest.changed),
  }));
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
