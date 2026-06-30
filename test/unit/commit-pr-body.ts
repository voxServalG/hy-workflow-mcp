import { buildCommitBody } from "../../src/tools/commit.js";
import { computePlanHash, type PlanDoc } from "../../src/state.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function extractPlanDocJson(body: string): { fenceLine: string; json: string } {
  const marker = "<summary>Raw PlanDoc JSON</summary>\n\n";
  const start = body.indexOf(marker);
  if (start === -1) throw new Error("missing raw PlanDoc details marker");
  const fenceStart = start + marker.length;
  const fenceEnd = body.indexOf("\n", fenceStart);
  if (fenceEnd === -1) throw new Error("missing opening JSON fence");
  const fenceLine = body.slice(fenceStart, fenceEnd);
  const fence = fenceLine.replace(/json$/, "");
  const close = `\n${fence}\n\n</details>`;
  const jsonStart = fenceEnd + 1;
  const jsonEnd = body.indexOf(close, jsonStart);
  if (jsonEnd === -1) throw new Error("missing closing JSON fence");
  return { fenceLine, json: body.slice(jsonStart, jsonEnd) };
}

const plan: PlanDoc = {
  task: "write exact PlanDoc into PR body",
  scope: {
    changes: ["src/tools/commit.ts", "docs/tools.md"],
    new_files: ["test/unit/commit-pr-body.ts"],
    delete: [],
  },
  boundary: {
    dependency_dag: "hy_commit reads the current amended PlanDoc from WorkflowState; downstream CI and merge do not rewrite PR body.",
    entry_points: ["npm run build", "npm test"],
    no_new_external: true,
  },
  verify: {
    platform: { python_version: "N/A", setup: ["npm ci"] },
    smoke: [{ command: "npm run build", expected_exit: 0, description: "compile" }],
    tests: [{ command: "npm test", expected_exit: 0, description: "full suite" }],
  },
  risks: ["Scenario: PlanDoc contains markdown fences ```json; impact: PR body fence can break; mitigation: choose a longer fence."],
  discussion: "Use the current state.plan snapshot after any hy_amend_plan recovery. A stored approval summary was rejected because it is not raw PlanDoc.",
  branch: "fix/plan-doc-pr-body",
  verify_hash: null,
  pr_number: null,
};

const verifyHash = "abc123def456";
const userBody = "User summary\n\n- keep this first";
const body = buildCommitBody({ body: userBody, plan, verifyHash });

assert(body.startsWith(userBody), "commit body should preserve user-provided body at the top");
assert(body.includes("**Scope**"), "commit body should keep the existing human scope summary");
assert(body.includes("**Boundary**"), "commit body should keep the existing boundary summary");
assert(body.includes("**Verify**"), "commit body should keep the existing verify summary");
assert(body.includes("**PlanDoc audit**"), "commit body should include a PlanDoc audit section");
assert(body.includes(`- planHash: \`${computePlanHash(plan)}\``), "commit body should include the current plan hash");
assert(body.includes(`- verifyHash: \`${verifyHash}\``), "commit body should include the top-level verify hash");

const extracted = extractPlanDocJson(body);
assert(extracted.fenceLine.startsWith("````json"), "PlanDoc JSON fence should be longer than embedded triple backticks");
const parsed = JSON.parse(extracted.json);
assert(JSON.stringify(parsed) === JSON.stringify(plan), "raw PlanDoc JSON should parse back to the exact current PlanDoc snapshot");
assert(parsed.branch === "fix/plan-doc-pr-body", "raw PlanDoc should preserve runtime branch field");
assert(parsed.pr_number === null, "raw PlanDoc should preserve PR number as it existed before createPr");
