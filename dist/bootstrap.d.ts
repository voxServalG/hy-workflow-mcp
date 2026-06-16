import { type ToolResult } from "./tools/_base.js";
export declare const SETUP_VERSION = "2026.06.16.1";
export declare const SETUP_STAMP: string;
export declare const SETUP_COMMAND = "curl -fsSL https://raw.githubusercontent.com/voxServalG/hy-workflow-mcp/main/setup | bash";
export type SetupStamp = {
    schemaVersion?: string;
    setupVersion?: string;
    generatedAt?: string;
    artifacts?: string[];
};
export type SetupCheck = {
    status: "current" | "missing_stamp" | "outdated" | "unreadable";
    currentVersion: string | null;
    latestVersion: string;
    stampPath: string;
};
export declare function setupStampPath(root?: string): string;
export declare function readSetupStamp(root?: string): SetupStamp | null;
export declare function checkSetupStamp(root?: string): SetupCheck;
export declare function setupUpdateRequiredResult(check: SetupCheck): ToolResult;
export declare function attachSetupCheck<T extends Record<string, any>>(result: T, check: SetupCheck): T;
export declare function createSetupGate(root?: string): () => ToolResult | null;
