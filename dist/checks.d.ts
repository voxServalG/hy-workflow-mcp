import type { ImplementationManifest, PendingPlanAmendment, PlanDoc, WorkflowState } from "./state.js";
export interface CheckResult {
    layer: string;
    name: string;
    passed: boolean;
    detail: string;
    hard: boolean;
    classification?: "hard_fail" | "amend_required" | "warning";
}
export declare function runDocLint(root: string): CheckResult[];
export declare function runCodeLint(root: string): CheckResult[];
export declare function runCompile(root: string): CheckResult[];
export declare function buildImplementationManifest(root: string): ImplementationManifest;
export declare function suggestPlanAmendment(plan: PlanDoc, manifest: ImplementationManifest): PendingPlanAmendment | null;
export declare function runScopeCheck(root: string, plan: PlanDoc, manifest?: ImplementationManifest): CheckResult[];
export declare function runBoundaryCheck(root: string, plan: PlanDoc): CheckResult[];
export declare function runPlatform(plan: PlanDoc): CheckResult[];
export declare function runSmoke(plan: PlanDoc, root: string): CheckResult[];
export declare function runTests(plan: PlanDoc, root: string): CheckResult[];
export interface VerifyReport {
    allPassed: boolean;
    hardFailed: number;
    total: number;
    checks: CheckResult[];
    status: "passed" | "amend_required" | "hard_fail";
    implementationManifest: ImplementationManifest;
    suggestedAmendment: PendingPlanAmendment | null;
}
export declare function runAllChecks(root: string, state: WorkflowState): VerifyReport;
