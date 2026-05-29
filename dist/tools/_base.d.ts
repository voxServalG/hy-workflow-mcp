import type { Phase } from "../state.js";
import { readState, writeState, transition, assertPhase } from "../state.js";
export type ToolResult = {
    next: Phase;
    [key: string]: any;
};
export { readState, writeState, transition, assertPhase };
