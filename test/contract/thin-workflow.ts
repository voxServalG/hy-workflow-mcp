import * as fs from "node:fs";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../../src/package-meta.js";
import { RUNTIME_CONFIG_SOURCE_ENV, RUNTIME_CONFIG_SOURCE_SCHEMA } from "../../src/config.js";
import { renderWorkflowTemplate } from "../../src/setup/shared.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const template = fs.readFileSync("templates/hy-workflow.yml", "utf-8");
const rendered = renderWorkflowTemplate();
const reusable = fs.readFileSync(".github/workflows/reusable-verify.yml", "utf-8");
const exactPackage = `${PACKAGE_NAME}@${PACKAGE_VERSION}`;

assert(Buffer.byteLength(template) < 2_000, "thin workflow template must remain human-reviewable");
assert((template.match(/__HY_WORKFLOW_PACKAGE_SPEC__/g) ?? []).length === 1, "template must contain one exact-package placeholder");
assert(!rendered.includes("__HY_WORKFLOW_PACKAGE_SPEC__") && rendered.includes(exactPackage), "rendered workflow must pin the exact package version");
for (const workflow of [template, reusable]) {
  assert(workflow.includes("permissions:\n  contents: read"), "workflow must use least-privilege read-only permissions");
  assert(workflow.includes(`${RUNTIME_CONFIG_SOURCE_ENV}: ${RUNTIME_CONFIG_SOURCE_SCHEMA}`), "new workflow must carry the exact project-config authority signal");
  assert(/actions\/checkout@[a-f0-9]{40}/.test(workflow), "checkout must be pinned to an immutable full commit SHA");
  assert(workflow.includes("persist-credentials: false"), "checkout credentials must not persist");
  for (const forbidden of [
    "Run native project CI",
    "HY_WORKFLOW_INTERNAL_LINT_BUNDLE",
    "__HY_WORKFLOW_LINT_BUNDLE_BASE64__",
    "pnpm-lock.yaml",
    "requirements.txt",
    "Cargo.toml",
    "go.mod",
    "AGENTS.md",
    "codelint.json",
    "doclint.json",
    "contents: write",
    "pull-requests: write",
  ]) assert(!workflow.includes(forbidden), `thin workflow must not contain ${forbidden}`);
}
assert(reusable.includes(exactPackage), "reusable workflow must pin the exact published package version");
assert((rendered.match(/\n    name: Verify\n/g) ?? []).length === 1, "thin caller must expose one stable Verify job identity");

console.log("thin-workflow: exact-version, least-privilege, no-inference contract passes");
