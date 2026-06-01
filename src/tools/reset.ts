import { readState, writeState, statePath } from "../state.js";
import type { ToolResult } from "./_base.js";
import * as fs from "node:fs";

export async function handleReset(): Promise<ToolResult> {
  const state = readState();
  const prevPhase = state.phase;

  const p = statePath();
  if (fs.existsSync(p)) fs.unlinkSync(p);

  const fresh = {
    version: "1" as const,
    phase: "init" as const,
    branch: null,
    prNumber: null,
    plan: null,
    approval: null,
    verifyHash: null,
  };
  writeState(fresh);

  return {
    next: "init",
    message: `Workflow reset from "${prevPhase}" to "init". .hy/workflow.json cleared.`,
  };
}
