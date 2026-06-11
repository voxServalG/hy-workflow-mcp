import type { WorkflowState, Phase } from "../state.js";
import { readState, writeState, transition, assertPhase } from "../state.js";

// Every tool handler follows this pattern:
//   1. readState()
//   2. assertPhase(state, "expected")
//   3. do work
//   4. transition(state, nextPhase) → writeState
//   5. return { next, ...result }

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

export function toolResult(next: Phase, fields: Omit<ToolResult, "next"> = {}): ToolResult {
  return {
    ok: fields.ok ?? fields.error === undefined,
    phase: fields.phase ?? next,
    next,
    ...fields,
  };
}

// Shared helper
export { readState, writeState, transition, assertPhase };
