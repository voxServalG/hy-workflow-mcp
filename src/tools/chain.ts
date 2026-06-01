import { readState, writeState, transition, assertPhase, projectRoot } from "../state.js";
import { checkout, pull, rebaseDev, pushForce } from "../git.js";
import type { ToolResult } from "./_base.js";

export async function handleChain(args: { branches: string[] }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "chain");

  const root = projectRoot();
  const results: string[] = [];

  // Pull latest dev
  checkout(root, "dev");
  pull(root);

  for (const br of args.branches) {
    checkout(root, br);
    const r = rebaseDev(root);
    if (!r.ok) {
      return { next: "chain", error: `Rebase failed for ${br}: ${r.error}`, done: results };
    }
    pushForce(root, br);
    results.push(`${br}: rebased + pushed`);
  }

  checkout(root, "dev");
  const next = transition(state, "done");
  writeState(next);

  return { next: "done", done: results, message: `Rebased ${results.length} branches. Workflow complete. All downstream branches synced.` };
}
