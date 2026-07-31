import * as fs from "node:fs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/package-meta.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { renderWorkflowTemplate } from "../../src/setup/shared.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const template = fs.readFileSync("templates/hy-workflow.yml", "utf-8");
const rendered = renderWorkflowTemplate();
const exact = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

assert(template !== rendered && rendered.includes(exact), "render must replace one package placeholder with the exact package version");
assert((template.match(/__HY_WORKFLOW_PACKAGE_SPEC__/g) ?? []).length === 1, "template must contain one exact package placeholder");
assert(!rendered.includes("__HY_WORKFLOW_PACKAGE_SPEC__"), "rendered workflow must not retain its placeholder");
assert(template.includes("  pull_request:\n") && template.includes("  workflow_dispatch:\n") && !template.includes("  push:\n"), "thin workflow must use PR/manual triggers only");
assert(template.includes("permissions:\n  contents: read\n"), "thin workflow must grant only read-only contents permission");
assert(template.includes(`${RUNTIME_CONFIG_SOURCE_ENV}: ${RUNTIME_CONFIG_SOURCE_SCHEMA}`), "thin workflow must carry the exact new-config authority signal");
assert(/actions\/checkout@[a-f0-9]{40}/.test(template) && template.includes("persist-credentials: false"), "checkout must be immutable and must not persist credentials");
assert(Buffer.byteLength(rendered) < 2_000, "rendered workflow must remain small enough for direct review");
for (const forbidden of [
  "HY_WORKFLOW_INTERNAL_LINT_BUNDLE",
  "__HY_WORKFLOW_LINT_BUNDLE_BASE64__",
  "Run native project CI",
  "ci.commands",
  "AGENTS.md",
  "codelint.json",
  "doclint.json",
  "actions/upload-artifact",
  "contents: write",
]) assert(!template.includes(forbidden), `thin workflow must not contain ${forbidden}`);

console.log("setup-workflow: thin exact-version policy runner contract passes");
