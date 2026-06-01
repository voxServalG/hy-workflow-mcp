import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch } from "../state.js";
import { checkout, pull, rebaseDev, pushForce } from "../git.js";
import type { ToolResult } from "./_base.js";

export async function handleChain(args: { branches: string[] }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "chain");

  const root = projectRoot();
  const results: string[] = [];

  const base = getBaseBranch(root);

  // Pull latest base
  checkout(root, base);
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

  checkout(root, base);
  const next = transition(state, "done");
  writeState(next);

  return { next: "done", done: results, message: `Rebased ${results.length} branches. Workflow complete. All downstream branches synced.` };
}
