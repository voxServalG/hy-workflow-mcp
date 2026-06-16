import { type ToolResult } from "./_base.js";
type AmendPlanArgs = {
    approved: string;
    note?: string;
};
export declare function handleAmendPlan(args: AmendPlanArgs): Promise<ToolResult>;
export {};
