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
  [key: string]: any;
};

// Shared helper
export { readState, writeState, transition, assertPhase };
