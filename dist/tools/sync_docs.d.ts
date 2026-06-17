import { type ImplementationManifest, type PlanDoc } from "../state.js";
import { type ToolResult } from "./_base.js";
export declare function isSyncDocumentPath(file: string): boolean;
export declare function allowedSyncDocumentPaths(plan: PlanDoc): string[];
export declare function implementationFilesForDigest(plan: PlanDoc, manifest: ImplementationManifest): string[];
export declare function implementationDigest(root: string, plan: PlanDoc, manifest: ImplementationManifest): string;
export declare function handleSyncDocs(): Promise<ToolResult>;
