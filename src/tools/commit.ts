import { readState, writeState, transition, assertPhase, projectRoot, getBaseBranch } from "../state.js";
import { commitAll, push, createPr } from "../git.js";
import type { ToolResult } from "./_base.js";

interface Section {
  heading: string;
  content: string;
}

export async function handleCommit(args: { title: string; sections?: Section[]; body?: string }): Promise<ToolResult> {
  const state = readState();
  assertPhase(state, "commit");

  if (!state.plan) return { next: "commit", error: "No plan" };
  if (!state.verifyHash) return { next: "commit", error: "Missing verifyHash" };
  if (!state.branch) return { next: "commit", error: "No active branch" };

  const root = projectRoot();

  // Build PR body from sections or fallback to raw body
  let userBody = "";
  if (args.sections?.length) {
    userBody = args.sections.map(s => `## ${s.heading}\n\n${s.content}`).join("\n\n");
  } else if (args.body) {
    userBody = args.body;
  }

  const body = [
    userBody,
    "",
    "---",
    "",
    "**Scope**",
    `- Changes: ${state.plan.scope.changes.join(", ") || "none"}`,
    `- New files: ${state.plan.scope.new_files.join(", ") || "none"}`,
    `- Delete: ${state.plan.scope.delete.join(", ") || "none"}`,
    "",
    "**Boundary**",
    `- Entry points: ${state.plan.boundary.entry_points.length} checks`,
    `- No new deps: ${state.plan.boundary.no_new_external}`,
    "",
    "**Verify**",
    `- smoke: ${state.plan.verify.smoke.length} checks, tests: ${state.plan.verify.tests.length} checks`,
    `- hash: \`${state.verifyHash}\``,
  ].join("\n");

  const c = commitAll(root, args.title, body);
  if (!c.ok) return { next: "edit", error: c.error };

  const p = push(root, state.branch);
  if (!p.ok) return { next: "edit", error: p.error };

  const pr = createPr(root, args.title, body, getBaseBranch(root), state.branch);
  if (!pr.ok) return { next: "edit", error: pr.error };

  const next = transition(state, "ci");
  next.prNumber = pr.prNumber ?? null;
  next.plan!.pr_number = next.prNumber;
  writeState(next);

  return {
    next: "ci",
    prNumber: pr.prNumber,
    url: pr.url,
    message: `PR #${pr.prNumber} created. Waiting for CI...`,
  };
}
