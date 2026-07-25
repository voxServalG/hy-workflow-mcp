export type CommandContract = {
  name: string;
  handlerFile: string;
  docsFile: string;
  phase: string;
  description: string;
  destructive: boolean;
};

export const COMMAND_CONTRACTS: CommandContract[] = [
  { name: "hy_init", handlerFile: "src/tools/init.ts", docsFile: "docs/tools.md", phase: "init, plan", description: "Validate setup artifacts and workflow rules", destructive: false },
  { name: "hy_read_docs", handlerFile: "src/tools/read_docs.ts", docsFile: "docs/tools.md", phase: "plan, approve, edit, verify", description: "Read project docs for workflow gates", destructive: false },
  { name: "hy_plan", handlerFile: "src/tools/plan.ts", docsFile: "docs/tools.md", phase: "plan", description: "Validate and store a PlanDoc", destructive: false },
  { name: "hy_approve", handlerFile: "src/tools/approve.ts", docsFile: "docs/tools.md", phase: "approve", description: "Apply explicit user approval or rejection", destructive: false },
  { name: "hy_branch", handlerFile: "src/tools/branch.ts", docsFile: "docs/tools.md", phase: "branch", description: "Create the implementation branch", destructive: true },
  { name: "hy_edit", handlerFile: "src/tools/edit.ts", docsFile: "docs/tools.md", phase: "branch, edit, verify", description: "Lock implementation scope", destructive: false },
  { name: "hy_sync_docs", handlerFile: "src/tools/sync_docs.ts", docsFile: "docs/tools.md", phase: "edit, verify", description: "Confirm documentation sync after edits", destructive: false },
  { name: "hy_verify", handlerFile: "src/tools/verify.ts", docsFile: "docs/tools.md", phase: "edit, verify", description: "Run all verification layers (sync fast path)", destructive: false },
  { name: "hy_exam_plan", handlerFile: "src/tools/exam-plan.ts", docsFile: "docs/tools.md", phase: "edit, verify", description: "Async verify step 1: issue an exam manifest (checks list + nonces) without running commands", destructive: false },
  { name: "hy_exam_submit", handlerFile: "src/tools/exam-submit.ts", docsFile: "docs/tools.md", phase: "edit, verify", description: "Async verify step 2: submit agent-run check results; server validates nonces, commands, exit codes, and tree fingerprint before stamping verifyHash", destructive: false },
  { name: "hy_amend_plan", handlerFile: "src/tools/amend_plan.ts", docsFile: "docs/tools.md", phase: "verify", description: "Apply approved scope amendments", destructive: false },
  { name: "hy_commit", handlerFile: "src/tools/commit.ts", docsFile: "docs/tools.md", phase: "commit", description: "Commit approved scope, create PR, and poll CI until green", destructive: true },
  { name: "hy_merge", handlerFile: "src/tools/merge.ts", docsFile: "docs/tools.md", phase: "merge", description: "Merge the approved PR and auto-rebase downstream branches", destructive: true },
  { name: "hy_reset", handlerFile: "src/tools/reset.ts", docsFile: "docs/tools.md", phase: "any", description: "Recovery: reset workflow state to plan", destructive: true },
  { name: "hy_status", handlerFile: "src/tools/status.ts", docsFile: "docs/tools.md", phase: "any", description: "Inspect workflow state", destructive: false },
];

export const COMMAND_NAMES = COMMAND_CONTRACTS.map(command => command.name);

export function commandNamesFromToolDefinitions(tools: Array<{ name?: string }>): string[] {
  return tools.map(tool => tool.name).filter((name): name is string => typeof name === "string").sort();
}

export function assertCommandCatalogMatchesTools(tools: Array<{ name?: string }>): void {
  const catalog = [...COMMAND_NAMES].sort();
  const actual = commandNamesFromToolDefinitions(tools);
  if (JSON.stringify(catalog) !== JSON.stringify(actual)) {
    throw new Error(`MCP tool catalog drift: catalog=${catalog.join(',')} actual=${actual.join(',')}`);
  }
}

