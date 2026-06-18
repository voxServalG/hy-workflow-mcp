export type Phase = "init" | "plan" | "approve" | "branch" | "edit" | "verify" | "commit" | "ci" | "merge" | "chain" | "done";
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
    pendingAmendment?: PendingPlanAmendment | null;
    implementationManifest?: ImplementationManifest | null;
    documentReads?: DocumentReads | null;
    syncDocs?: SyncDocsRecord | null;
}
export interface LegacyRuntimeDiagnostic {
    file: string;
    tracked: boolean;
    message: string;
    remediation?: string;
}
export declare function statePath(): string;
export declare function scopePath(): string;
export declare function projectRoot(): string;
export declare function legacyRuntimeDiagnostics(root?: string): LegacyRuntimeDiagnostic[];
export declare function cleanupLegacyRuntimeFiles(root?: string): void;
export declare function readState(): WorkflowState;
export declare function writeState(state: WorkflowState): void;
export declare function assertPhase(state: WorkflowState, ...expected: Phase[]): void;
export declare function transition(state: WorkflowState, to: Phase): WorkflowState;
export declare class StateError extends Error {
    constructor(message: string);
}
export declare function computeVerifyHash(state: WorkflowState): string;
export declare function computePlanHash(plan: PlanDoc | null): string | null;
export declare function documentReadHealth(state: WorkflowState, currentImplementationDigest?: string): DocumentReadHealth;
export declare function currentBranch(root: string): string;
export declare function getBaseBranch(root: string): string;
