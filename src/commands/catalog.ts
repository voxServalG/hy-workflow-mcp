import {
  PHASES,
  WORKFLOW_STAGES,
  type Phase,
  type WorkflowStage,
} from "../runtime/state-machine.js";

export type CommandContract = {
  command: string;
  legacyAction: `hy_${string}`;
  handlerFile: `src/tools/${string}.ts`;
  phases: readonly Phase[];
  stages: readonly WorkflowStage[];
  description: string;
  destructive: boolean;
};

export const COMMAND_CONTRACTS = [
  { command: "init", legacyAction: "hy_init", handlerFile: "src/tools/init.ts", phases: ["init"], stages: ["init.ready"], description: "Validate runtime readiness and initialize external workflow state", destructive: false },
  { command: "status", legacyAction: "hy_status", handlerFile: "src/tools/status.ts", phases: PHASES, stages: WORKFLOW_STAGES, description: "Inspect the authoritative workflow state and route", destructive: false },
  { command: "read-docs", legacyAction: "hy_read_docs", handlerFile: "src/tools/read_docs.ts", phases: ["plan", "approve", "edit"], stages: ["plan.before_plan", "approve.before_approve", "edit.after_edit"], description: "Read project documentation for the three evidence gates", destructive: false },
  { command: "plan", legacyAction: "hy_plan", handlerFile: "src/tools/plan.ts", phases: ["plan"], stages: ["plan.compose", "plan.review"], description: "Validate and store a PlanDoc", destructive: false },
  { command: "approve", legacyAction: "hy_approve", handlerFile: "src/tools/approve.ts", phases: ["approve"], stages: ["approve.before_approve", "approve.decision"], description: "Apply one explicit decision to one exact PlanDoc", destructive: false },
  { command: "branch", legacyAction: "hy_branch", handlerFile: "src/tools/branch.ts", phases: ["branch"], stages: ["branch.create"], description: "Create the implementation branch", destructive: true },
  { command: "edit", legacyAction: "hy_edit", handlerFile: "src/tools/edit.ts", phases: ["edit"], stages: ["edit.scope", "edit.implementation"], description: "Lock the approved implementation scope", destructive: false },
  { command: "sync-docs", legacyAction: "hy_sync_docs", handlerFile: "src/tools/sync_docs.ts", phases: ["edit"], stages: ["edit.after_edit", "edit.sync_docs"], description: "Record current post-edit documentation evidence", destructive: false },
  { command: "verify", legacyAction: "hy_verify", handlerFile: "src/tools/verify.ts", phases: ["edit", "verify"], stages: ["edit.sync_docs", "verify.run"], description: "Run the synchronous verification path", destructive: false },
  { command: "exam-plan", legacyAction: "hy_exam_plan", handlerFile: "src/tools/exam-plan.ts", phases: ["edit", "verify"], stages: ["edit.sync_docs", "verify.run"], description: "Issue a bound asynchronous verification manifest", destructive: false },
  { command: "exam-submit", legacyAction: "hy_exam_submit", handlerFile: "src/tools/exam-submit.ts", phases: ["edit", "verify"], stages: ["edit.sync_docs", "verify.run"], description: "Validate one complete asynchronous result set", destructive: false },
  { command: "amend-plan", legacyAction: "hy_amend_plan", handlerFile: "src/tools/amend_plan.ts", phases: ["verify"], stages: ["verify.amendment"], description: "Apply an explicit decision to a pending scope amendment", destructive: false },
  { command: "commit", legacyAction: "hy_commit", handlerFile: "src/tools/commit.ts", phases: ["commit"], stages: ["commit.prepare", "commit.publish", "commit.ci"], description: "Commit approved scope, publish the pull request, and observe CI", destructive: true },
  { command: "merge", legacyAction: "hy_merge", handlerFile: "src/tools/merge.ts", phases: ["merge"], stages: ["merge.reconcile", "merge.sync"], description: "Reconcile and merge the pull request, then synchronize downstream branches", destructive: true },
  { command: "reset", legacyAction: "hy_reset", handlerFile: "src/tools/reset.ts", phases: PHASES, stages: WORKFLOW_STAGES, description: "Reset external workflow state to planning", destructive: true },
] as const satisfies readonly CommandContract[];

export type WorkflowCliCommandName = typeof COMMAND_CONTRACTS[number]["command"];
export type LegacyWorkflowAction = typeof COMMAND_CONTRACTS[number]["legacyAction"];

/** Canonical public surface. */
export const CLI_COMMAND_NAMES = COMMAND_CONTRACTS.map(contract => contract.command) as WorkflowCliCommandName[];

/** Compatibility mapping for the unchanged kernel handlers and retirement code. */
export const LEGACY_ACTION_NAMES = COMMAND_CONTRACTS.map(contract => contract.legacyAction) as LegacyWorkflowAction[];

/**
 * @deprecated Only the legacy MCP retirement/preflight kernel consumes this
 * name. New public contracts must use CLI_COMMAND_NAMES.
 */
export const COMMAND_NAMES = LEGACY_ACTION_NAMES;

export function commandForLegacyAction(action: string): WorkflowCliCommandName | null {
  return COMMAND_CONTRACTS.find(contract => contract.legacyAction === action)?.command ?? null;
}

export function legacyActionForCommand(command: string): LegacyWorkflowAction | null {
  return COMMAND_CONTRACTS.find(contract => contract.command === command)?.legacyAction ?? null;
}

function sortedNames(values: readonly string[]): string[] {
  return [...values].sort();
}

export function assertCommandCatalogMatchesCli(commands: readonly string[]): void {
  const catalog = sortedNames(CLI_COMMAND_NAMES);
  const actual = sortedNames(commands);
  if (JSON.stringify(catalog) !== JSON.stringify(actual)) {
    throw new Error(`CLI command catalog drift: catalog=${catalog.join(",")} actual=${actual.join(",")}`);
  }
}

export function commandNamesFromToolDefinitions(tools: Array<{ name?: string }>): string[] {
  return tools.map(tool => tool.name).filter((name): name is string => typeof name === "string").sort();
}

/** Compatibility assertion for the legacy kernel preflight only. */
export function assertCommandCatalogMatchesTools(tools: Array<{ name?: string }>): void {
  const catalog = sortedNames(LEGACY_ACTION_NAMES);
  const actual = commandNamesFromToolDefinitions(tools);
  if (JSON.stringify(catalog) !== JSON.stringify(actual)) {
    throw new Error(`Legacy kernel action catalog drift: catalog=${catalog.join(",")} actual=${actual.join(",")}`);
  }
}
