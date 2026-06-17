export type Phase = "init" | "plan" | "approve" | "branch" | "edit" | "verify" | "commit" | "ci" | "merge" | "chain" | "done";
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
export type DocumentReadStage = "before_plan" | "before_approve";
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
}
export interface DocumentReads {
    beforePlan?: DocumentReadSnapshot | null;
    beforeApprove?: DocumentReadSnapshot | null;
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
export declare function currentBranch(root: string): string;
export declare function getBaseBranch(root: string): string;
