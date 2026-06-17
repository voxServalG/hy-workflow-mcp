export type CodeExt = string | string[];
export declare const JS_TS_CODE_EXTS: Set<string>;
export declare const PYTHON_CODE_EXTS: Set<string>;
export declare const KNOWN_CODE_EXTS: Set<string>;
export declare function normalizeCodeExt(value: unknown): string[];
export declare function codeExtOr(value: unknown, fallback: CodeExt): CodeExt;
export declare function formatCodeExt(value: CodeExt): string;
export declare function validateCodeExt(value: unknown): string[];
export declare function isKnownCodeExt(ext: string): boolean;
