import type { PlanDoc, WorkflowState } from "./state.js";
export interface CheckResult {
    layer: string;
    name: string;
    passed: boolean;
    detail: string;
    hard: boolean;
}
export declare function runDocLint(root: string): CheckResult[];
export declare function runCodeLint(root: string): CheckResult[];
export declare function runCompile(root: string): CheckResult[];
export declare function runScopeCheck(root: string, plan: PlanDoc): CheckResult[];
export declare function runBoundaryCheck(root: string, plan: PlanDoc): CheckResult[];
export declare function runPlatform(plan: PlanDoc): CheckResult[];
export declare function runSmoke(plan: PlanDoc, root: string): CheckResult[];
export declare function runTests(plan: PlanDoc, root: string): CheckResult[];
export interface VerifyReport {
    allPassed: boolean;
    hardFailed: number;
    total: number;
    checks: CheckResult[];
}
export declare function runAllChecks(root: string, state: WorkflowState): VerifyReport;
