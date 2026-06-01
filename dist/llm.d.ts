import type { PlanDoc } from "./state.js";
export interface GenerateResult {
    ok: true;
    plan: PlanDoc;
}
export interface GenerateError {
    ok: false;
    error: string;
}
export declare function generatePlanDoc(task: string, context: string): Promise<GenerateResult | GenerateError>;
