import type { Phase } from "../state.js";
import { readState, writeState, transition, assertPhase } from "../state.js";
export type ToolResult = {
    next: Phase;
    ok?: boolean;
    phase?: Phase;
    display?: {
        title?: string;
        body?: string;
        files?: string[];
        urls?: string[];
    };
    hint?: string;
    requires_user?: boolean;
    stop_here?: boolean;
    allowedTools?: string[];
    blockedTools?: string[];
    recovery?: {
        tool?: string;
        instruction?: string;
        byLayer?: Record<string, string>;
    };
    [key: string]: any;
};
export declare function toolResult(next: Phase, fields?: Omit<ToolResult, "next">): ToolResult;
export { readState, writeState, transition, assertPhase };
