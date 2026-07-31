import { readFileSync } from "node:fs";
import ts from "typescript";
import { createInitialWorkflowState } from "../../src/state.js";
import { setupUpdateRequiredResult } from "../../src/bootstrap.js";
import { invalidWorkflowStateResult, toolResult } from "../../src/tools/_base.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const producerFiles = [
  "src/tools/init.ts",
  "src/tools/read_docs.ts",
  "src/tools/status.ts",
  "src/tools/reset.ts",
  "src/tools/edit.ts",
  "src/tools/sync_docs.ts",
  "src/tools/branch.ts",
];
const forbiddenEverywhere = new Set(["display", "summary", "hint", "prompt", "instruction", "purpose", "findings", "byLayer", "pipeline", "stopAfter", "resumeAfter"]);
const forbiddenToolResultTopLevel = new Set([...forbiddenEverywhere, "message"]);

function propertyName(node: ts.PropertyName): string | null {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

for (const file of producerFiles) {
  const source = readFileSync(file, "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node.name);
      if (name && forbiddenEverywhere.has(name)) throw new Error(`${file} still owns Agent prose property ${name}`);
    }
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "toolResult"
        && node.arguments[1]
        && ts.isObjectLiteralExpression(node.arguments[1])) {
      for (const property of node.arguments[1].properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        if (name && forbiddenToolResultTopLevel.has(name)) throw new Error(`${file} still emits top-level Agent prose property ${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const phrase of ["Purpose:", "Audit dimensions:"]) {
    assert(!source.includes(phrase), `${file} still embeds model-facing document guidance: ${phrase}`);
  }
}

function assertFactOnly(value: unknown, label: string): void {
  const visit = (current: unknown, location: string): void => {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${location}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, item] of Object.entries(current as Record<string, unknown>)) {
      assert(!forbiddenEverywhere.has(key), `${location}.${key} must not contain Agent prose`);
      visit(item, `${location}.${key}`);
    }
  };
  visit(value, label);
}

const defaultAction = toolResult("plan", { error: "failure fact", requires_user: true });
assertFactOnly(defaultAction, "defaultAction");
assert(defaultAction.userAction?.kind === "review_failure", "requires_user should retain a structured action kind");

const invalidState = invalidWorkflowStateResult(
  { ...createInitialWorkflowState(), phase: "edit", stage: "edit.implementation" },
  "TEST_INVALID_STATE",
  "State fact is invalid.",
);
assertFactOnly(invalidState, "invalidState");
assert(invalidState.error?.code === "TEST_INVALID_STATE" && invalidState.recovery?.strategy === "reset" && invalidState.recovery.tool === "hy_reset", "invalid state should preserve error and reset route facts");

const setupGate = setupUpdateRequiredResult({
  status: "unreadable",
  currentVersion: null,
  latestVersion: "test",
  stampPath: "/external/deployment.json",
});
assertFactOnly(setupGate, "setupGate");
assert(setupGate.error?.code === "SETUP_UPDATE_REQUIRED" && setupGate.recovery?.strategy === "external_action", "setup gate should preserve error and external-action facts");

const skillRequirements: Record<string, string[]> = {
  "skills/hy-init/SKILL.md": ["zero project-file changes", "missing artifacts", "current concrete user request"],
  "skills/hy-read-docs/SKILL.md": ["changedSinceBaseline", "continue or replan", "same PlanDoc again"],
  "skills/hy-status/SKILL.md": ["impossible state", "exact reset route", "task information"],
  "skills/hy-reset/SKILL.md": ["workflow derivations were cleared", "repository files", "concrete request"],
  "skills/hy-edit/SKILL.md": ["exact scope", "hy-workflow read-docs", "after_edit"],
  "skills/hy-sync-docs/SKILL.md": ["allowedDocs", "broken-link details", "automatic and current"],
  "skills/hy-branch/SKILL.md": ["exact created branch", "retryability", "category/topic arguments"],
};
for (const [file, required] of Object.entries(skillRequirements)) {
  const source = readFileSync(file, "utf8");
  for (const token of required) assert(source.includes(token), `${file} is missing presentation rule: ${token}`);
}
