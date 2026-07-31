import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ToolResult } from "../../src/output/envelope.js";
import {
  WORKFLOW_CLI_COMMANDS,
  WORKFLOW_CLI_SCHEMA,
  WORKFLOW_CLI_VERSION,
  WorkflowCliInputError,
  parseWorkflowCliArgs,
  runWorkflowCli,
  stableJsonStringify,
  toWorkflowCliEnvelope,
  workflowCommandArgv,
  workflowCommandForTool,
} from "../../src/cli/workflow.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function expectInputError(name: string, build: () => unknown, code: string): void {
  try {
    build();
    throw new Error(`${name} should fail`);
  } catch (error) {
    assert(error instanceof WorkflowCliInputError, `${name} should return a typed CLI input error`);
    assert(error.code === code, `${name} should return ${code}, got ${error.code}`);
  }
}

const inline = parseWorkflowCliArgs([
  "branch",
  "--input",
  "{\"topic\":\"cli-adapter\",\"category\":\"feat\"}",
]);
assert(inline.command === "branch" && inline.input.category === "feat", "inline JSON should parse as one command input object");
assert(inline.inputSource === "inline", "inline input should retain its deterministic source classification");
assert(
  stableJsonStringify(inline.input) === "{\"category\":\"feat\",\"topic\":\"cli-adapter\"}",
  "route JSON should sort object keys deterministically",
);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "hy-workflow-cli-"));
try {
  const inputFile = path.join(root, "approve.json");
  fs.writeFileSync(inputFile, "{\"approved\":\"approve\",\"decisionId\":\"plan:abc123\"}\n", "utf-8");
  const fromFile = parseWorkflowCliArgs(["approve", "--input-file", "approve.json"], { cwd: root });
  assert(fromFile.input.approved === "approve" && fromFile.inputSource === "file", "a regular JSON file should be accepted");
  assert(fromFile.input.decisionId === "plan:abc123", "approval files should retain the bound decision identity");

  const symlink = path.join(root, "approve-link.json");
  fs.symlinkSync(inputFile, symlink);
  expectInputError(
    "symbolic-link input",
    () => parseWorkflowCliArgs(["approve", "--input-file", symlink]),
    "INPUT_FILE_UNSAFE",
  );
  expectInputError(
    "directory input",
    () => parseWorkflowCliArgs(["approve", "--input-file", root]),
    "INPUT_FILE_UNSAFE",
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

expectInputError("missing command", () => parseWorkflowCliArgs([]), "COMMAND_MISSING");
expectInputError("unknown command", () => parseWorkflowCliArgs(["serve"]), "COMMAND_UNKNOWN");
expectInputError("conflicting sources", () => parseWorkflowCliArgs(["approve", "--input", "{}", "--input-file", "x"]), "INPUT_SOURCE_CONFLICT");
expectInputError("array input", () => parseWorkflowCliArgs(["approve", "--input", "[]"]), "INPUT_JSON_NOT_OBJECT");
expectInputError("unknown field", () => parseWorkflowCliArgs(["status", "--input", "{\"verbose\":true}"]), "INPUT_UNKNOWN_FIELDS");
expectInputError("missing required input", () => parseWorkflowCliArgs(["commit"]), "INPUT_SCHEMA_INVALID");
expectInputError("approval without decision id", () => parseWorkflowCliArgs(["approve", "--input", "{\"approved\":\"approve\"}"]), "INPUT_SCHEMA_INVALID");
expectInputError("amendment without decision id", () => parseWorkflowCliArgs(["amend-plan", "--input", "{\"approved\":\"approve\"}"]), "INPUT_SCHEMA_INVALID");
expectInputError(
  "invalid exam result",
  () => parseWorkflowCliArgs(["exam-submit", "--input", "{\"examId\":\"exam-1234567890123456\",\"results\":[{\"id\":\"one\",\"command\":\"npm test\",\"nonce\":\"n\",\"exitCode\":0,\"shell\":true}]}"]),
  "INPUT_UNKNOWN_FIELDS",
);

const expectedTools = [
  "hy_init",
  "hy_status",
  "hy_read_docs",
  "hy_plan",
  "hy_approve",
  "hy_branch",
  "hy_edit",
  "hy_sync_docs",
  "hy_verify",
  "hy_exam_plan",
  "hy_exam_submit",
  "hy_amend_plan",
  "hy_commit",
  "hy_merge",
  "hy_reset",
];
assert(WORKFLOW_CLI_COMMANDS.length === expectedTools.length, "the CLI should expose every stage-aligned workflow command exactly once");
for (let index = 0; index < expectedTools.length; index += 1) {
  assert(workflowCommandForTool(expectedTools[index]) === WORKFLOW_CLI_COMMANDS[index], `${expectedTools[index]} should map to its stage-aligned CLI command`);
}
assert(
  JSON.stringify(workflowCommandArgv("branch", { topic: "cli-adapter", category: "feat" }))
    === JSON.stringify(["hy-workflow", "branch", "--input", "{\"category\":\"feat\",\"topic\":\"cli-adapter\"}"]),
  "routes should expose exact argv arrays rather than shell command strings",
);

const handlerResult = {
  ok: false,
  next: "edit",
  phase: "edit",
  stage: "edit.implementation",
  status: "blocked",
  nextAction: {
    tool: "hy_read_docs",
    arguments: { task: "refresh", stage: "before_plan" },
    phase: "plan",
    stage: "plan.before_plan",
    automatic: false,
  },
  control: { automatic: false, stop: true, reason: "review_required" },
  userAction: {
    kind: "approval",
    decisionId: "plan:abc123",
    prompt: "Approve this prose",
    instruction: "Read this prose",
    options: ["approve", "reject"],
  },
  data: { stable: true },
  display: { title: "agent title", body: "agent body" },
  summary: "agent summary",
  hint: "agent hint",
  message: "structured handler message",
  pipeline: ["hy_edit", "hy_verify"],
  stopAfter: "verify",
  resumeAfter: "edit",
  _notice: { update: { message: "agent notice" } },
  error: {
    type: "scope",
    subtype: "scope_drift",
    code: "SCOPE_DRIFT",
    message: "Scope changed.",
    hint: "Repair prose.",
    retryable: true,
  },
  allowedTools: ["hy_read_docs", "hy_status"],
  blockedTools: ["hy_commit", "hy_merge"],
  recovery: {
    strategy: "repair_and_retry",
    tool: "hy_edit",
    command: "hy-workflow edit && echo unsafe",
    instruction: "Repair prose.",
    byLayer: { scope: "keep factual layer routing" },
  },
} as ToolResult;

const envelope = toWorkflowCliEnvelope("verify", handlerResult);
assert(envelope.schema === WORKFLOW_CLI_SCHEMA && envelope.version === WORKFLOW_CLI_VERSION, "the CLI envelope should be explicitly versioned");
assert(envelope.phase === "edit" && envelope.stage === "edit.implementation" && envelope.status === "blocked", "phase, stage, and status should survive projection");
assert((envelope.data as any).stable === true, "structured handler facts should survive projection");
for (const field of ["display", "summary", "hint", "message", "pipeline", "stopAfter", "resumeAfter", "_notice"]) {
  assert(!(field in envelope), `top-level control or agent prose field ${field} should be removed`);
}
assert(!("hint" in (envelope.error as Record<string, unknown>)), "structured error hints should be removed while error facts remain");
assert(envelope.error?.code === "SCOPE_DRIFT", "structured error type, subtype, code, and message should survive");
assert(envelope.route.action.command === "read-docs", "nextAction tools should become CLI command routes");
assert(
  JSON.stringify(envelope.route.action.argv)
    === JSON.stringify(["hy-workflow", "read-docs", "--input", "{\"stage\":\"before_plan\",\"task\":\"refresh\"}"]),
  "next actions should contain exact, deterministic argv",
);
assert(envelope.route.allowed.join(",") === "read-docs,status", "allowed tools should become CLI command names");
assert(envelope.route.blocked.join(",") === "commit,merge", "blocked tools should become CLI command names");
assert(envelope.route.userAction?.decisionId === "plan:abc123", "typed decision facts should survive");
assert(!("prompt" in envelope.route.userAction!) && !("instruction" in envelope.route.userAction!), "user-action prose should be removed");
assert(envelope.route.recovery?.command === "edit", "known recovery tools should become CLI commands");
assert(JSON.stringify(envelope.route.recovery?.argv) === JSON.stringify(["hy-workflow", "edit"]), "recovery should expose argv without a shell");
assert(!("instruction" in envelope.route.recovery!) && !Object.values(envelope.route.recovery!).includes("hy-workflow edit && echo unsafe"), "recovery prose and shell commands should be removed");
assert(!("byLayer" in envelope.route.recovery!), "model-facing layer guidance should not enter public recovery facts");

function routeFixture(overrides: Record<string, unknown>): ToolResult {
  return {
    ok: true,
    next: "plan",
    phase: "plan",
    stage: "plan.before_plan",
    status: "ready",
    nextAction: {
      tool: null,
      phase: "plan",
      stage: "plan.before_plan",
      automatic: false,
    },
    control: { automatic: false, stop: false, reason: "automatic" },
    userAction: null,
    allowedTools: [],
    blockedTools: [],
    ...overrides,
  } as ToolResult;
}

const initHandoff = toWorkflowCliEnvelope("init", routeFixture({
  allowedTools: ["hy_read_docs", "hy_status"],
}));
assert(initHandoff.route.action.command === "read-docs", "init should issue a typed read-docs handoff");
assert(initHandoff.route.action.argv === null, "a handoff with missing task input must not fabricate argv");
assert((initHandoff.route.action.input as any)?.stage === "before_plan", "init should preserve the signed before_plan selector");
assert(
  JSON.stringify(initHandoff.route.action.inputRequired) === JSON.stringify([
    { path: "task", type: "string", source: "current_user_task", minLength: 1 },
  ]),
  "init should declare exactly how the current user task completes the handoff",
);

const planHandoff = toWorkflowCliEnvelope("read-docs", routeFixture({
  stage: "plan.compose",
  nextAction: { tool: null, phase: "plan", stage: "plan.compose", automatic: false },
  allowedTools: ["hy_plan"],
}));
assert(planHandoff.route.action.command === "plan" && planHandoff.route.action.argv === null, "plan composition should be a partial plan command");
assert(
  planHandoff.route.action.inputRequired?.map(item => `${item.path}:${item.source}`).join(",")
    === "task:current_user_task,plan:skill_synthesis",
  "plan composition should separate user task facts from Skill synthesis",
);

const approvalHandoff = toWorkflowCliEnvelope("plan", routeFixture({
  next: "approve",
  phase: "approve",
  stage: "approve.decision",
  nextAction: { tool: null, phase: "approve", stage: "approve.decision", automatic: false },
  control: { automatic: false, stop: true, reason: "approval_required" },
  userAction: { kind: "approval", decisionId: "plan:abc123", options: ["approve", "reject", "revise"] },
  allowedTools: ["hy_approve"],
}));
const approvalRequirement = approvalHandoff.route.action.inputRequired?.[0];
assert(approvalHandoff.route.action.command === "approve" && approvalRequirement?.source === "human_decision", "approval must remain a typed human decision");
assert(approvalRequirement?.decisionId === "plan:abc123", "approval input must stay bound to the issued decision id");
assert((approvalHandoff.route.action.input as any)?.decisionId === "plan:abc123", "approval route input must carry the issued decision id");

const branchHandoff = toWorkflowCliEnvelope("approve", routeFixture({
  next: "branch",
  phase: "branch",
  stage: "branch.create",
  nextAction: { tool: null, phase: "branch", stage: "branch.create", automatic: false },
  allowedTools: ["hy_branch"],
}));
assert(
  branchHandoff.route.action.command === "branch"
    && branchHandoff.route.action.inputRequired?.map(item => item.path).join(",") === "category,topic",
  "branch handoff should declare bounded Skill-synthesized inputs",
);

const afterEditHandoff = toWorkflowCliEnvelope("edit", routeFixture({
  next: "edit",
  phase: "edit",
  stage: "edit.implementation",
  nextAction: { tool: null, phase: "edit", stage: "edit.implementation", automatic: false },
  control: { automatic: false, stop: true, reason: "external_work_required" },
  allowedTools: ["hy_read_docs"],
}));
assert(
  JSON.stringify(afterEditHandoff.route.action.argv)
    === JSON.stringify(["hy-workflow", "read-docs", "--input", "{\"stage\":\"after_edit\"}"]),
  "edit completion should sign the exact after_edit audit command while the external-work gate remains explicit",
);

const syncHandoff = toWorkflowCliEnvelope("read-docs", routeFixture({
  next: "edit",
  phase: "edit",
  stage: "edit.after_edit",
  nextAction: { tool: null, phase: "edit", stage: "edit.after_edit", automatic: false },
  allowedTools: ["hy_sync_docs"],
}));
assert(syncHandoff.route.action.argv?.join(" ") === "hy-workflow sync-docs", "after_edit should sign the exact document-sync command");

const verificationChoice = toWorkflowCliEnvelope("sync-docs", routeFixture({
  next: "verify",
  phase: "edit",
  stage: "edit.sync_docs",
  nextAction: { tool: "hy_verify", phase: "verify", stage: "verify.run", automatic: true },
  allowedTools: ["hy_verify"],
}));
assert(verificationChoice.route.action.command === null && verificationChoice.route.action.argv === null, "verification scale selection must not preselect a command");
assert(verificationChoice.route.choices?.join(",") === "verify,exam-plan", "verification selection should expose the two execution forms explicitly");
assert(verificationChoice.route.control.stop === true, "verification selection must stop for Skill judgment");

const examSubmitHandoff = toWorkflowCliEnvelope("exam-plan", routeFixture({
  next: "verify",
  phase: "verify",
  stage: "verify.run",
  examId: "exam-1234567890123456",
  nextAction: { tool: null, phase: "verify", stage: "verify.run", automatic: false },
  allowedTools: ["hy_exam_submit"],
}));
assert((examSubmitHandoff.route.action.input as any)?.examId === "exam-1234567890123456", "exam handoff should preserve the issued exam id");
assert(examSubmitHandoff.route.action.inputRequired?.[0]?.path === "results", "exam handoff should require only external results when exam id is known");

const commitHandoff = toWorkflowCliEnvelope("verify", routeFixture({
  next: "commit",
  phase: "commit",
  stage: "commit.prepare",
  nextAction: { tool: null, phase: "commit", stage: "commit.prepare", automatic: false },
  allowedTools: ["hy_commit"],
}));
assert(commitHandoff.route.action.inputRequired?.map(item => item.path).join(",") === "title,body", "commit handoff should require Skill-synthesized title and body");

const terminal = toWorkflowCliEnvelope("reset", routeFixture({
  nextAction: { tool: null, phase: "plan", stage: "plan.before_plan", automatic: false },
}));
assert(terminal.route.action.command === null && terminal.route.action.argv === null, "a true terminal result should keep a null action");
assert(terminal.route.action.inputRequired === undefined, "a terminal action must not invent required inputs");


const invalidRun = await runWorkflowCli(["unknown"]);
assert(invalidRun.exitCode === 1 && invalidRun.envelope.schema === WORKFLOW_CLI_SCHEMA, "parse failures should use the same versioned envelope");
assert(invalidRun.stdout === `${JSON.stringify(invalidRun.envelope)}\n`, "CLI output should be exactly one compact JSON document");
assert(invalidRun.envelope.route.action.argv?.join(" ") === "hy-workflow status", "failure recovery should also use exact argv");

const invalidCommitRun = await runWorkflowCli(["commit"]);
assert(invalidCommitRun.envelope.command === "commit", "a valid command name should survive input-parse failures");
assert(invalidCommitRun.envelope.error?.code === "INPUT_SCHEMA_INVALID", "typed CLI validation codes should survive failure projection");

console.log("workflow-cli: strict JSON parsing, safe files, handler routing, and prose-free envelopes pass");
