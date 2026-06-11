import { type ToolResult } from "./_base.js";
export declare const INIT_COMMIT_ARTIFACTS: string[];
export declare const INIT_LOCAL_ARTIFACTS: string[];
export declare const REQUIRED_SETUP_ARTIFACTS: string[];
export declare function ensureLocalArtifactIgnores(root: string): boolean;
export declare function initArtifactGuidance(): {
    commitArtifacts: string[];
    localArtifacts: string[];
    body: string;
};
export declare function setupArtifactStatus(root: string): {
    requiredArtifacts: string[];
    missingArtifacts: string[];
    ready: boolean;
};
export declare function harnessArtifactStatus(root: string): {
    requiredArtifacts: string[];
    missingArtifacts: string[];
    ready: boolean;
};
export declare function handleInit(): Promise<ToolResult>;
