import type { ToolResult } from "./_base.js";
import type { PlanDoc } from "../state.js";
export declare function handlePlan(args: {
    task: string;
    plan?: PlanDoc;
}): Promise<ToolResult>;
