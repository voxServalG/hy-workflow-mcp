import { type CodeExt } from "./code_ext.js";
export type ProjectKind = "python" | "typescript" | "unknown" | "mixed";
export type JsonObject = Record<string, any>;
export type ConfigSuggestion = {
    codeExt: CodeExt;
    codeDirs: string[];
    lintDirs: string[];
    docsDir: string;
    baseBranch: string;
    maxCodeLines: number;
    maxDocLines: number;
};
export type ConfigDrift = {
    file: string;
    field: string;
    expected: unknown;
    actual: unknown;
};
export type ConfigCheckResult = {
    ok: boolean;
    phase: "config";
    next: "config";
    display: {
        title: string;
        body: string;
    };
    hint: string;
    requires_user?: boolean;
    stop_here?: boolean;
    allowedTools?: string[];
    recovery?: {
        tool?: string;
        instruction?: string;
    };
    project: {
        kind: ProjectKind;
        evidence: string[];
    };
    issues: string[];
    drift: ConfigDrift[];
    suggestion: ConfigSuggestion;
    suggestedCommand: string;
    changed?: string[];
    preserved?: Record<string, string[]>;
    dryRun?: boolean;
};
export declare const UNIFIED_CONFIG_FILE = "hy-workflow.json";
export declare function detectProject(root: string): {
    kind: ProjectKind;
    evidence: string[];
};
export declare function defaultSuggestion(root: string): ConfigSuggestion;
export declare function compatConfigs(existing: Record<string, JsonObject | null>, unified: JsonObject): Record<string, JsonObject>;
export declare function ensureConfigDefaults(root: string, options?: {
    dryRun?: boolean;
}): ConfigCheckResult;
export declare function readUnifiedConfig(root: string, suggestion?: ConfigSuggestion): JsonObject | null;
export declare function withRuntimeCompatConfigs<T>(root: string, run: () => T): T;
export declare function applyConfig(root: string, suggestion: ConfigSuggestion, options: {
    preserveExisting: boolean;
    dryRun: boolean;
    mode?: string;
}): ConfigCheckResult;
export declare function checkConfig(root: string, suggestion?: ConfigSuggestion): ConfigCheckResult;
export declare function buildSuggestedCommand(suggestion: ConfigSuggestion, needsExplicit?: boolean): string;
export declare function configHelp(): string;
export declare function runConfigCli(argv: string[], root?: string): {
    exitCode: number;
    stdout: string;
};
