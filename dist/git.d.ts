import type { PlanDoc } from "./state.js";
export declare function createBranch(root: string, category: string, topic: string): {
    ok: boolean;
    branch: string;
    error?: string;
};
export declare function commitAll(root: string, title: string, body: string): {
    ok: boolean;
    hash?: string;
    error?: string;
};
export declare function commitScope(root: string, scope: PlanDoc["scope"], title: string, body: string): {
    ok: boolean;
    hash?: string;
    error?: string;
};
export declare function push(root: string, branch: string): {
    ok: boolean;
    error?: string;
};
export declare function pushForce(root: string, branch: string): {
    ok: boolean;
    error?: string;
};
export declare function createPr(root: string, title: string, body: string, baseBranch: string, headBranch: string): {
    ok: boolean;
    prNumber?: number;
    url?: string;
    error?: string;
};
export declare function mergePr(prNumber: number): {
    ok: boolean;
    error?: string;
};
export declare function checkCi(prNumber: number): {
    ok: boolean;
    allGreen: boolean;
    checks: Array<{
        name: string;
        conclusion: string;
    }>;
    error?: string;
};
export declare function checkout(root: string, branch: string): {
    ok: boolean;
    error?: string;
};
export declare function pull(root: string): {
    ok: boolean;
    error?: string;
};
export declare function rebaseDev(root: string): {
    ok: boolean;
    error?: string;
};
