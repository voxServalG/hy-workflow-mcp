import { type ToolResult } from "./_base.js";
type CiArgs = {
    timeoutSeconds?: number;
    intervalSeconds?: number;
};
export declare function handleCi(args?: CiArgs): Promise<ToolResult>;
export {};
