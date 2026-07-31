import { readFileSync } from "node:fs";
import ts from "typescript";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function propertyName(property: ts.ObjectLiteralElementLike): string | null {
  if (ts.isShorthandPropertyAssignment(property)) return property.name.text;
  if (!ts.isPropertyAssignment(property)) return null;
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function assertNoNestedProse(
  file: string,
  owner: "recovery" | "userAction",
  object: ts.ObjectLiteralExpression,
): void {
  const forbidden = owner === "recovery"
    ? new Set(["instruction", "byLayer"])
    : new Set(["prompt", "instruction"]);
  for (const property of object.properties) {
    const name = propertyName(property);
    assert(!name || !forbidden.has(name), `${file} ${owner} still owns Agent prose field ${name}`);
  }
}

const producers = [
  "src/tools/verify.ts",
  "src/tools/exam-plan.ts",
  "src/tools/exam-submit.ts",
  "src/tools/amend_plan.ts",
] as const;
const forbiddenTopLevel = new Set([
  "display",
  "summary",
  "hint",
  "message",
  "pipeline",
  "stopAfter",
  "resumeAfter",
]);

for (const file of producers) {
  const source = readFileSync(file, "utf8");
  assert(!source.includes("invalidWorkflowStateResult"), `${file} must not delegate to the prose-producing invalid-state helper`);
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let resultCount = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "toolResult") {
      resultCount += 1;
      const facts = node.arguments[1];
      assert(facts && ts.isObjectLiteralExpression(facts), `${file} toolResult must receive an object literal fact envelope`);
      for (const property of facts.properties) {
        const name = propertyName(property);
        assert(!name || !forbiddenTopLevel.has(name), `${file} toolResult still owns top-level Agent prose field ${name}`);
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
        if (name === "recovery") assertNoNestedProse(file, "recovery", property.initializer);
        if (name === "userAction") assertNoNestedProse(file, "userAction", property.initializer);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(resultCount > 0, `${file} must retain structured tool results`);
}

const skill = readFileSync("skills/hy-verify/SKILL.md", "utf8");
for (const requirement of [
  "structured facts and routes, not Agent prose",
  "documentReadHealth",
  "failedChecks",
  "suggestedAmendment",
  "decisionId",
  "bounded stdout/stderr tails",
  "lint:",
  "compile:",
  "scope:",
  "boundary:",
  "platform:",
  "smoke:",
  "tests:",
  "AMENDMENT_DECISION_INVALID",
  "non-material scope narrowing",
  "after_edit",
  "sync-docs",
]) {
  assert(skill.includes(requirement), `hy-verify Skill is missing migrated guidance: ${requirement}`);
}


const publishProducers = [
  { file: "src/tools/commit.ts", resultBuilder: "commitResult" },
  { file: "src/tools/merge.ts", resultBuilder: "mergeResult" },
] as const;

for (const producer of publishProducers) {
  const source = readFileSync(producer.file, "utf8");
  const tree = ts.createSourceFile(producer.file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let resultCount = 0;

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === producer.resultBuilder) {
      resultCount += 1;
      const facts = node.arguments[1];
      assert(facts && ts.isObjectLiteralExpression(facts), `${producer.file} result builder must receive an object literal fact envelope`);
      for (const property of facts.properties) {
        const name = propertyName(property);
        assert(!name || !forbiddenTopLevel.has(name), `${producer.file} result still owns top-level Agent prose field ${name}`);
        if (!ts.isPropertyAssignment(property) || !ts.isObjectLiteralExpression(property.initializer)) continue;
        if (name === "recovery") assertNoNestedProse(producer.file, "recovery", property.initializer);
        if (name === "userAction") assertNoNestedProse(producer.file, "userAction", property.initializer);
      }
    }
    if (ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.expression.text === "invalidWorkflowStateResult") {
      assert(node.arguments.length <= 3, `${producer.file} invalid-state result still passes ignored presentation prose`);
    }
    if (ts.isPropertyAssignment(node)) {
      const name = propertyName(node);
      assert(name !== "hint", `${producer.file} still emits nested error.hint`);
      assert(!name || !["instruction", "byLayer", "prompt"].includes(name), `${producer.file} still emits nested Agent prose field ${name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  assert(resultCount > 0, `${producer.file} must retain structured tool results`);
}

const presentationSkills = [
  {
    path: "skills/hy-commit/SKILL.md",
    required: ["structured facts and routes, not Agent prose", "COMMIT_ARGUMENTS_MISMATCH", "CI_CHECKS_REQUIRED", "failedChecks", "error.detail", "recovery strategy, tool, and exact arguments"],
  },
  {
    path: "skills/hy-merge/SKILL.md",
    required: ["PR_MERGE_OUTCOME_UNCONFIRMED", "POST_MERGE_SYNC_INCOMPLETE", "data.outcome", "data.remaining", "recovery strategy and tool", "done.completed"],
  },
] as const;

for (const owner of presentationSkills) {
  const text = readFileSync(owner.path, "utf8");
  for (const requirement of owner.required) {
    assert(text.includes(requirement), `${owner.path} is missing migrated presentation rule: ${requirement}`);
  }
  for (const field of ["display", "summary", "hint", "allowedTools"]) {
    assert(!text.includes(field), `${owner.path} must consume machine facts rather than removed field ${field}`);
  }
}

console.log("verify-presentation: verification, commit, and merge producers emit machine facts while stage Skills own human guidance");
